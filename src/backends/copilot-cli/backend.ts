import { realpath } from 'node:fs/promises';

import { AgentLoomError } from '../../core/errors';
import type {
  AgentBackendInterface,
  AgentEvent,
  AgentRequestInterface,
  BackendCapabilitiesInterface,
  BackendSessionInterface,
  CancelOptionsInterface,
  CancelResultInterface,
  CreateSessionOptionsInterface,
  WorkspaceInterface,
} from '../../core/types';

export interface CopilotPromptRunnerInterface {
  run(prompt: string, options: CopilotPromptRunOptionsInterface): AsyncIterable<string>;
  cancel?(
    backendSessionId: string,
    options?: CancelOptionsInterface,
  ): Promise<CancelResultInterface>;
  dispose?(backendSessionId: string): Promise<void>;
}

export interface CopilotPromptRunOptionsInterface {
  backendSessionId: string;
  cwd: string;
  signal?: AbortSignal;
}

export interface CopilotCliBackendOptionsInterface {
  runner?: CopilotPromptRunnerInterface;
}

export class CopilotCliBackend implements AgentBackendInterface {
  readonly name = 'copilot-cli';
  readonly #runner: CopilotPromptRunnerInterface;
  readonly #workspaceRoots = new Map<string, string>();

  constructor(options: CopilotCliBackendOptionsInterface = {}) {
    this.#runner = options.runner ?? new BunCopilotPromptRunner();
  }

  capabilities(): BackendCapabilitiesInterface {
    return {
      persistentSessions: false,
      serverSideTools: true,
      permissionRequests: true,
      externalApprovalDecisions: false,
      backendInternalPauseResume: true,
      cancellation: true,
    };
  }

  async createSession(
    workspace: WorkspaceInterface,
    options: CreateSessionOptionsInterface,
  ): Promise<BackendSessionInterface> {
    const canonicalRoot = await canonicalizeWorkspaceRoot(workspace.rootPath);
    if (canonicalRoot !== workspace.rootPath) {
      throw new AgentLoomError(
        'workspace_changed',
        'Workspace root changed before backend session creation',
      );
    }
    const backendSessionId = `copilot_cli_${options.bridgeSessionId}`;
    this.#workspaceRoots.set(backendSessionId, canonicalRoot);
    return {
      bridgeSessionId: options.bridgeSessionId,
      backendSessionId,
      workspaceId: workspace.id,
      threadId: options.threadId,
      status: 'active',
    };
  }

  async resumeSession(session: BackendSessionInterface): Promise<BackendSessionInterface> {
    if (!session.backendSessionId) {
      throw new AgentLoomError(
        'backend_session_not_active',
        'Cannot resume a reserved backend session',
      );
    }
    return session;
  }

  async *send(
    session: BackendSessionInterface,
    request: AgentRequestInterface,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (!session.backendSessionId) {
      throw new AgentLoomError(
        'backend_session_not_active',
        'Cannot send to a reserved backend session',
      );
    }
    if (session.workspaceId !== request.workspaceId || session.threadId !== request.threadId) {
      throw new AgentLoomError(
        'backend_session_mismatch',
        'Backend session does not match request scope',
      );
    }

    const cwd = this.#workspaceRoots.get(session.backendSessionId);
    if (!cwd) {
      throw new AgentLoomError(
        'backend_session_not_found',
        'Backend session workspace was not found',
      );
    }

    let text = '';
    for await (const delta of this.#runner.run(request.input.message, {
      backendSessionId: session.backendSessionId,
      cwd,
      ...(signal ? { signal } : {}),
    })) {
      text += delta;
      yield {
        type: 'text.delta',
        turnId: request.turnId,
        delta,
      };
    }

    yield {
      type: 'turn.succeeded',
      turnId: request.turnId,
      output: { text },
    };
  }

  async cancel(
    session: BackendSessionInterface,
    options?: CancelOptionsInterface,
  ): Promise<CancelResultInterface> {
    if (!session.backendSessionId) {
      return { status: 'not_found' };
    }
    return (
      (await this.#runner.cancel?.(session.backendSessionId, options)) ?? { status: 'cancelled' }
    );
  }

  async disposeSession(session: BackendSessionInterface): Promise<void> {
    if (session.backendSessionId) {
      await this.#runner.dispose?.(session.backendSessionId);
      this.#workspaceRoots.delete(session.backendSessionId);
    }
  }
}

async function canonicalizeWorkspaceRoot(rootPath: string): Promise<string> {
  try {
    return await realpath(rootPath);
  } catch (cause) {
    throw new AgentLoomError(
      'workspace_canonicalization_failed',
      'Workspace root could not be resolved',
      {
        cause,
      },
    );
  }
}

export class BunCopilotPromptRunner implements CopilotPromptRunnerInterface {
  readonly #processes = new Map<string, ReturnType<typeof Bun.spawn>>();

  async *run(prompt: string, options: CopilotPromptRunOptionsInterface): AsyncIterable<string> {
    const proc = Bun.spawn(
      [
        'copilot',
        '--no-color',
        '--no-custom-instructions',
        '--disable-builtin-mcps',
        '--log-level',
        'error',
        '--stream',
        'on',
        '--output-format',
        'json',
        '--prompt',
        prompt,
      ],
      {
        cwd: options.cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    this.#processes.set(options.backendSessionId, proc);

    const abort = () => proc.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });

    const stderrPromise = new Response(proc.stderr).text();

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const text = extractTextFromCopilotOutput(line);
          if (text.length > 0) {
            yield text;
          }
        }
      }

      buffer += decoder.decode();
      const remainingText = extractTextFromCopilotOutput(buffer);
      if (remainingText.length > 0) {
        yield remainingText;
      }

      const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
      if (exitCode !== 0) {
        throw new AgentLoomError('backend_process_failed', `Copilot CLI exited with ${exitCode}`, {
          cause: stderr,
        });
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.#processes.delete(options.backendSessionId);
    }
  }

  async cancel(
    backendSessionId: string,
    options: CancelOptionsInterface = { timeoutMs: 0, forceAfterTimeout: false },
  ): Promise<CancelResultInterface> {
    const proc = this.#processes.get(backendSessionId);
    if (!proc) {
      return { status: 'not_found' };
    }

    proc.kill('SIGTERM');
    if (!options.forceAfterTimeout) {
      return { status: 'cancelled' };
    }

    const exited = await waitForExit(proc, options.timeoutMs);
    if (exited) {
      return { status: 'cancelled' };
    }

    proc.kill('SIGKILL');
    return { status: 'timed_out' };
  }

  async dispose(backendSessionId: string): Promise<void> {
    const proc = this.#processes.get(backendSessionId);
    if (!proc) {
      return;
    }
    proc.kill('SIGTERM');
    if (!(await waitForExit(proc, 250))) {
      proc.kill('SIGKILL');
    }
  }
}

async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  const exited = proc.exited.then(() => true);
  return await Promise.race([exited, timeout]);
}

export function extractTextFromCopilotOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parts = lines.flatMap((line) => {
    try {
      return extractTextFromValue(JSON.parse(line));
    } catch {
      return [line];
    }
  });
  return parts.join('');
}

function extractTextFromValue(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractTextFromValue);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  for (const key of ['assistant_response', 'assistantResponse', 'delta', 'text', 'content']) {
    const child = record[key];
    if (typeof child === 'string') {
      return [child];
    }
  }

  return Object.values(record).flatMap(extractTextFromValue);
}
