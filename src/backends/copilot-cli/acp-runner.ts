import { VolareError } from '../../core/errors';
import type { ICancelOptions, ICancelResult } from '../../core/types';
import { type ILogger, NoopLogger } from '../../logging/logger';
import {
  AcpJsonRpcPeer,
  type AcpPermissionPolicy,
  type IAcpWritable,
  isAcpAuthRequiredError,
  type JsonObject,
  type JsonValue,
  parseAcpSessionNewResponse,
  selectAcpAuthMethod,
} from './acp';
import {
  type CopilotCliPermissionMode,
  DEFAULT_COPILOT_CLI_PERMISSION_MODE,
  type ICopilotPromptRunner,
  type ICopilotPromptRunOptions,
} from './backend';

interface IAcpProcess {
  stdin: IAcpWritable;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number | null>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export interface IAcpCopilotPromptRunnerOptions {
  command?: string;
  permissionMode?: CopilotCliPermissionMode;
  maxWorkers?: number;
  requestTimeoutMs?: number;
  logger?: ILogger;
  spawn?: (args: string[], options: { cwd: string }) => IAcpProcess;
}

interface IAcpWorker {
  backendSessionId: string;
  cwd: string;
  proc: IAcpProcess;
  peer: AcpJsonRpcPeer;
  sessionId: string;
  active: IActivePrompt | null;
  generation: number;
}

interface IActivePrompt {
  generation: number;
  queue: TextQueue;
}

const DEFAULT_ACP_MAX_WORKERS = 10;
const DEFAULT_ACP_REQUEST_TIMEOUT_MS = 600_000;

export class AcpCopilotPromptRunner implements ICopilotPromptRunner {
  readonly #command: string;
  readonly #permissionMode: CopilotCliPermissionMode;
  readonly #maxWorkers: number;
  readonly #requestTimeoutMs: number;
  readonly #logger: ILogger;
  readonly #spawn: (args: string[], options: { cwd: string }) => IAcpProcess;
  readonly #workers = new Map<string, IAcpWorker>();
  readonly #creatingWorkers = new Map<string, Promise<IAcpWorker>>();
  readonly #startupKillers = new Map<string, () => void>();
  readonly #cancelledCreations = new Set<string>();
  #nextGeneration = 1;

  constructor(options: IAcpCopilotPromptRunnerOptions = {}) {
    this.#command = options.command ?? 'copilot';
    this.#permissionMode = options.permissionMode ?? DEFAULT_COPILOT_CLI_PERMISSION_MODE;
    this.#maxWorkers = options.maxWorkers ?? DEFAULT_ACP_MAX_WORKERS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ACP_REQUEST_TIMEOUT_MS;
    this.#logger = (options.logger ?? new NoopLogger()).child({
      component: 'backend',
      backend: 'copilot-cli',
      copilotRuntimeMode: 'acp',
    });
    this.#spawn =
      options.spawn ??
      ((args, spawnOptions) =>
        Bun.spawn(args, {
          cwd: spawnOptions.cwd,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...Bun.env,
            NO_COLOR: '1',
            CI: '1',
          },
        }));
  }

  async *run(prompt: string, options: ICopilotPromptRunOptions): AsyncIterable<string> {
    const worker = await this.#getOrCreateWorker(options.backendSessionId, options.cwd);
    if (worker.active) {
      throw new VolareError('backend_worker_busy', 'ACP worker already has an active prompt');
    }

    const queue = new TextQueue();
    const generation = worker.generation;
    worker.active = { generation, queue };
    const abortError = new VolareError('backend_cancelled', 'ACP prompt was aborted');
    const abort = () => {
      queue.fail(abortError);
      void this.#replaceWorker(worker, 'abort');
    };
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener('abort', abort, { once: true });
    }
    const startedAt = performance.now();
    let promptError: unknown;
    const promptResponse = worker.peer
      .request('session/prompt', {
        sessionId: worker.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      .then((response) => {
        const stopReason = parseStopReason(response.result);
        queue.close();
        this.#logger.info(
          {
            event: 'backend.acp.prompt.completed',
            backendSessionId: worker.backendSessionId,
            stopReason,
            durationMs: elapsedMs(startedAt),
          },
          'ACP prompt completed',
        );
        return stopReason;
      })
      .catch((error) => {
        promptError = error;
        queue.fail(error);
      })
      .finally(() => {
        options.signal?.removeEventListener('abort', abort);
        if (worker.active?.generation === generation) {
          worker.active = null;
        }
      });

    try {
      for await (const chunk of queue) {
        yield chunk;
      }
      await promptResponse;
      if (promptError) {
        throw promptError;
      }
    } catch (error) {
      if (this.#workers.get(worker.backendSessionId) === worker) {
        await this.#replaceWorker(worker, 'prompt_error');
      }
      throw error;
    }
  }

  async cancel(
    backendSessionId: string,
    options: ICancelOptions = { timeoutMs: 0, forceAfterTimeout: false },
  ): Promise<ICancelResult> {
    const worker = this.#workers.get(backendSessionId);
    const creating = this.#creatingWorkers.get(backendSessionId);
    if (!worker && creating) {
      this.#cancelledCreations.add(backendSessionId);
      this.#startupKillers.get(backendSessionId)?.();
      await creating.catch(() => undefined);
      return { status: 'cancelled' };
    }
    if (!worker?.active) {
      return { status: 'not_found' };
    }
    const activeGeneration = worker.active.generation;
    this.#workers.delete(backendSessionId);
    worker.active.queue.fail(new VolareError('backend_cancelled', 'ACP prompt was cancelled'));
    await worker.peer
      .notify('session/cancel', { sessionId: worker.sessionId })
      .catch(() => undefined);
    worker.peer.close();
    worker.proc.kill('SIGTERM');
    if (!options.forceAfterTimeout) {
      return { status: 'cancelled' };
    }
    const exited = await Promise.race([
      worker.proc.exited.then(() => true),
      Bun.sleep(options.timeoutMs).then(() => false),
    ]);
    if (this.#workers.get(backendSessionId)?.generation === activeGeneration) {
      this.#workers.delete(backendSessionId);
    }
    if (exited) {
      return { status: 'cancelled' };
    }
    worker.proc.kill('SIGKILL');
    return { status: 'timed_out' };
  }

  async dispose(backendSessionId: string): Promise<void> {
    const worker = this.#workers.get(backendSessionId);
    const creating = this.#creatingWorkers.get(backendSessionId);
    if (!worker && creating) {
      this.#cancelledCreations.add(backendSessionId);
      this.#startupKillers.get(backendSessionId)?.();
      await creating.catch(() => undefined);
      return;
    }
    if (!worker) {
      return;
    }
    this.#workers.delete(backendSessionId);
    worker.peer.close();
    worker.proc.kill('SIGTERM');
    await Promise.race([worker.proc.exited, Bun.sleep(250)]);
    worker.proc.kill('SIGKILL');
  }

  async #getOrCreateWorker(backendSessionId: string, cwd: string): Promise<IAcpWorker> {
    const existing = this.#workers.get(backendSessionId);
    if (existing) {
      if (existing.cwd !== cwd) {
        await this.dispose(backendSessionId);
      } else {
        return existing;
      }
    }
    const creating = this.#creatingWorkers.get(backendSessionId);
    if (creating) {
      return await creating;
    }
    if (this.#workers.size + this.#creatingWorkers.size >= this.#maxWorkers) {
      throw new VolareError('backend_worker_cap_exhausted', 'ACP worker cap exhausted');
    }
    const creatingWorker = this.#createWorker(backendSessionId, cwd);
    this.#creatingWorkers.set(backendSessionId, creatingWorker);
    try {
      return await creatingWorker;
    } finally {
      this.#creatingWorkers.delete(backendSessionId);
      this.#cancelledCreations.delete(backendSessionId);
    }
  }

  async #createWorker(backendSessionId: string, cwd: string): Promise<IAcpWorker> {
    const proc = this.#spawn(this.#buildArgs(), { cwd });
    let worker: IAcpWorker | undefined;
    const peer = new AcpJsonRpcPeer({
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      requestTimeoutMs: this.#requestTimeoutMs,
      permissionPolicy: permissionPolicy(this.#permissionMode),
      onNotification: (frame) => {
        if (!worker?.active) {
          return;
        }
        for (const text of extractTextDeltas(frame, worker.sessionId)) {
          worker.active.queue.push(text);
        }
      },
    });
    this.#startupKillers.set(backendSessionId, () => {
      peer.close();
      proc.kill('SIGTERM');
      proc.kill('SIGKILL');
    });
    try {
      const initializedAt = performance.now();
      if (this.#cancelledCreations.has(backendSessionId)) {
        throw new VolareError('backend_cancelled', 'ACP worker startup was cancelled');
      }
      const initializeSummary = await peer.initialize();
      if (this.#cancelledCreations.has(backendSessionId)) {
        throw new VolareError('backend_cancelled', 'ACP worker startup was cancelled');
      }
      const session = await this.#createAcpSession(peer, initializeSummary.authMethods, cwd);
      if (this.#cancelledCreations.has(backendSessionId)) {
        throw new VolareError('backend_cancelled', 'ACP worker startup was cancelled');
      }

      worker = {
        backendSessionId,
        cwd,
        proc,
        peer,
        sessionId: session.sessionId,
        active: null,
        generation: this.#nextGeneration,
      };
      this.#nextGeneration += 1;
      this.#workers.set(backendSessionId, worker);
      void proc.exited.then((exitCode) => {
        if (worker && this.#workers.get(backendSessionId) === worker) {
          this.#workers.delete(backendSessionId);
          worker.active?.queue.fail(
            new VolareError('backend_process_failed', `ACP worker exited with ${exitCode}`),
          );
          this.#logger.warn(
            {
              event: 'backend.acp.worker.exited',
              backendSessionId,
              exitCode,
              activeWorkers: this.#workers.size,
            },
            'ACP worker exited',
          );
        }
      });
      this.#logger.info(
        {
          event: 'backend.acp.worker.created',
          backendSessionId,
          handshakeMs: elapsedMs(initializedAt),
          activeWorkers: this.#workers.size,
        },
        'ACP worker created',
      );
      return worker;
    } catch (error) {
      peer.close();
      proc.kill('SIGTERM');
      await Promise.race([proc.exited, Bun.sleep(250)]);
      proc.kill('SIGKILL');
      throw error;
    } finally {
      this.#startupKillers.delete(backendSessionId);
    }
  }

  async #createAcpSession(
    peer: AcpJsonRpcPeer,
    authMethods: JsonValue,
    cwd: string,
  ): Promise<{ sessionId: string }> {
    try {
      return parseAcpSessionNewResponse(await this.#requestAcpSessionNew(peer, cwd));
    } catch (error) {
      if (!isAcpAuthRequiredError(error)) {
        throw error;
      }
      const authMethod = selectAcpAuthMethod(authMethods);
      if (!authMethod) {
        throw new VolareError(
          'backend_auth_method_missing',
          'ACP authentication is required, but Copilot CLI did not advertise a usable auth method. Run `copilot login` and retry.',
          { cause: error },
        );
      }
      try {
        await peer.authenticate(authMethod.methodId);
      } catch (authError) {
        throw new VolareError(
          'backend_auth_failed',
          'ACP authentication failed. Run `copilot login` and retry.',
          { cause: authError },
        );
      }
      try {
        return parseAcpSessionNewResponse(await this.#requestAcpSessionNew(peer, cwd));
      } catch (retryError) {
        if (isAcpAuthRequiredError(retryError)) {
          throw new VolareError(
            'backend_auth_required',
            'ACP authentication is required. Run `copilot login` and retry.',
            { cause: retryError },
          );
        }
        throw retryError;
      }
    }
  }

  async #requestAcpSessionNew(peer: AcpJsonRpcPeer, cwd: string): Promise<JsonValue | undefined> {
    return (
      await peer.request('session/new', {
        cwd,
        mcpServers: [],
      })
    ).result;
  }

  async #replaceWorker(worker: IAcpWorker, reason: string): Promise<void> {
    if (this.#workers.get(worker.backendSessionId) === worker) {
      this.#workers.delete(worker.backendSessionId);
    }
    worker.peer.close();
    worker.proc.kill('SIGTERM');
    await Promise.race([worker.proc.exited, Bun.sleep(250)]);
    worker.proc.kill('SIGKILL');
    this.#logger.warn(
      {
        event: 'backend.acp.worker.replaced',
        backendSessionId: worker.backendSessionId,
        reason,
        activeWorkers: this.#workers.size,
      },
      'ACP worker replaced',
    );
  }

  #buildArgs(): string[] {
    return [
      this.#command,
      '--acp',
      '--no-color',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      ...permissionArgs(this.#permissionMode),
      '--log-level',
      'error',
    ];
  }
}

class TextQueue implements AsyncIterable<string> {
  readonly #pending: string[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<string>): void;
    reject(error: unknown): void;
  }> = [];
  #closed = false;
  #error: unknown;

  push(value: string): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.#pending.push(value);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.#error) {
      return;
    }
    this.#error = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        if (this.#error) {
          throw this.#error;
        }
        const value = this.#pending.shift();
        if (value !== undefined) {
          return { value, done: false };
        }
        if (this.#closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<string>>((resolve, reject) =>
          this.#waiters.push({ resolve, reject }),
        );
      },
    };
  }
}

function extractTextDeltas(frame: JsonObject, sessionId: string): string[] {
  if (getField(frame, 'method') !== 'session/update') {
    return [];
  }
  const params = getField(frame, 'params');
  if (!isJsonObject(params) || getField(params, 'sessionId') !== sessionId) {
    return [];
  }
  const update = getField(params, 'update');
  if (!isJsonObject(update) || getField(update, 'sessionUpdate') !== 'agent_message_chunk') {
    return [];
  }
  const content = getField(update, 'content');
  if (!isJsonObject(content)) {
    return [];
  }
  const text = getField(content, 'text');
  return typeof text === 'string' ? [text] : [];
}

function parseStopReason(result: JsonValue | undefined): string {
  if (!isJsonObject(result)) {
    throw new VolareError('backend_acp_invalid_response', 'ACP prompt result must be an object');
  }
  const stopReason = getField(result, 'stopReason');
  if (typeof stopReason !== 'string') {
    throw new VolareError(
      'backend_acp_invalid_response',
      'ACP prompt result must include stopReason',
    );
  }
  return stopReason;
}

function permissionPolicy(mode: CopilotCliPermissionMode): AcpPermissionPolicy {
  return mode === 'full' ? 'allow' : 'deny';
}

function permissionArgs(mode: CopilotCliPermissionMode): string[] {
  switch (mode) {
    case 'restricted':
      return [];
    case 'web':
      return ['--allow-all-urls'];
    case 'full':
      return ['--allow-all'];
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getField(object: JsonObject, key: string): JsonValue | undefined {
  return object[key];
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
