import { realpath } from 'node:fs/promises';

import { AgentLoomError, toAgentLoomError } from '../../core/errors';
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
import { type LoggerInterface, NoopLogger } from '../../logging/logger';
import {
  createProcessIdentity,
  DefaultProcessIdentityValidator,
  type ProcessIdentityInterface,
  type ProcessIdentityValidatorInterface,
} from './process-identity';

type TrackedProcess = {
  proc: ReturnType<typeof Bun.spawn>;
  identity: ProcessIdentityInterface;
};

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
  logger?: LoggerInterface;
}

export class CopilotCliBackend implements AgentBackendInterface {
  readonly name = 'copilot-cli';
  readonly #runner: CopilotPromptRunnerInterface;
  readonly #logger: LoggerInterface;
  readonly #workspaceRoots = new Map<string, string>();

  constructor(options: CopilotCliBackendOptionsInterface = {}) {
    this.#runner = options.runner ?? new BunCopilotPromptRunner();
    this.#logger = (options.logger ?? new NoopLogger()).child({
      component: 'backend',
      backend: this.name,
    });
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
    const startedAt = Date.now();
    const logger = this.#logger.child({
      backendSessionId: session.backendSessionId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      turnId: request.turnId,
    });
    logger.info({ event: 'backend.turn.started' }, 'backend turn started');
    try {
      for await (const delta of this.#runner.run(formatCopilotPrompt(request.input), {
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
    } catch (error) {
      const agentError = toAgentLoomError(error);
      logger.error(
        {
          event: 'backend.turn.failed',
          durationMs: Date.now() - startedAt,
          errorCode: agentError.code,
          error: agentError,
        },
        'backend turn failed',
      );
      throw error;
    }

    logger.info(
      {
        event: 'backend.turn.completed',
        durationMs: Date.now() - startedAt,
        outputChars: text.length,
      },
      'backend turn completed',
    );
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
    const result = (await this.#runner.cancel?.(session.backendSessionId, options)) ?? {
      status: 'cancelled',
    };
    this.#logger.info(
      {
        event: 'backend.session.cancelled',
        backendSessionId: session.backendSessionId,
        status: result.status,
      },
      'backend session cancelled',
    );
    return result;
  }

  async disposeSession(session: BackendSessionInterface): Promise<void> {
    if (session.backendSessionId) {
      await this.#runner.dispose?.(session.backendSessionId);
      this.#workspaceRoots.delete(session.backendSessionId);
      this.#logger.info(
        { event: 'backend.session.disposed', backendSessionId: session.backendSessionId },
        'backend session disposed',
      );
    }
  }
}

function formatCopilotPrompt(input: AgentRequestInterface['input']): string {
  const sections: string[] = [];
  if (input.systemInstructions) {
    sections.push(`System instructions:\n${input.systemInstructions}`);
  }
  if (input.conversationHistory && input.conversationHistory.length > 0) {
    sections.push(
      `Conversation so far:\n${input.conversationHistory
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n\n')}`,
    );
  }
  sections.push(`User request:\n${input.message}`);
  return sections.join('\n\n');
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
  readonly #processes = new Map<string, Set<TrackedProcess>>();
  readonly #identityValidator: ProcessIdentityValidatorInterface;
  readonly #command: string;

  constructor(
    identityValidator: ProcessIdentityValidatorInterface = new DefaultProcessIdentityValidator(),
    command = 'copilot',
  ) {
    this.#identityValidator = identityValidator;
    this.#command = command;
  }

  async *run(prompt: string, options: CopilotPromptRunOptionsInterface): AsyncIterable<string> {
    const proc = Bun.spawn(
      [
        this.#command,
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
    const tracked = this.#trackProcess(options.backendSessionId, proc);

    const abort = () => this.#kill(tracked, 'SIGTERM');
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
      this.#untrackProcess(options.backendSessionId, tracked);
    }
  }

  async cancel(
    backendSessionId: string,
    options: CancelOptionsInterface = { timeoutMs: 0, forceAfterTimeout: false },
  ): Promise<CancelResultInterface> {
    const processes = this.#processes.get(backendSessionId);
    if (!processes || processes.size === 0) {
      return { status: 'not_found' };
    }

    const activeProcesses = [...processes];
    for (const tracked of activeProcesses) {
      this.#kill(tracked, 'SIGTERM');
    }
    if (!options.forceAfterTimeout) {
      return { status: 'cancelled' };
    }

    const exited = await waitForAllExits(activeProcesses, options.timeoutMs);
    if (exited) {
      return { status: 'cancelled' };
    }

    for (const tracked of activeProcesses) {
      this.#kill(tracked, 'SIGKILL');
    }
    return { status: 'timed_out' };
  }

  async dispose(backendSessionId: string): Promise<void> {
    const processes = this.#processes.get(backendSessionId);
    if (!processes || processes.size === 0) {
      return;
    }
    const activeProcesses = [...processes];
    for (const tracked of activeProcesses) {
      this.#kill(tracked, 'SIGTERM');
    }
    if (!(await waitForAllExits(activeProcesses, 250))) {
      for (const tracked of activeProcesses) {
        this.#kill(tracked, 'SIGKILL');
      }
    }
  }

  #trackProcess(backendSessionId: string, proc: ReturnType<typeof Bun.spawn>): TrackedProcess {
    const tracked = {
      proc,
      identity: createProcessIdentity(String(proc.pid), Date.now()),
    };
    const processes = this.#processes.get(backendSessionId);
    if (processes) {
      processes.add(tracked);
      return tracked;
    }
    this.#processes.set(backendSessionId, new Set([tracked]));
    return tracked;
  }

  #untrackProcess(backendSessionId: string, tracked: TrackedProcess): void {
    const processes = this.#processes.get(backendSessionId);
    if (!processes) {
      return;
    }
    processes.delete(tracked);
    if (processes.size === 0) {
      this.#processes.delete(backendSessionId);
    }
  }

  #kill(tracked: TrackedProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    this.#identityValidator.assertMatches(tracked.identity, String(tracked.proc.pid));
    tracked.proc.kill(signal);
  }
}

async function waitForAllExits(processes: TrackedProcess[], timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  const exited = Promise.all(processes.map((tracked) => tracked.proc.exited)).then(() => true);
  return await Promise.race([exited, timeout]);
}

export function extractTextFromCopilotOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parts = lines.flatMap((line) => {
    try {
      return extractTextFromValue(JSON.parse(line), line);
    } catch (cause) {
      if (!looksLikeStructuredJson(line)) {
        return [line];
      }
      throw new AgentLoomError(
        'backend_output_invalid',
        'Copilot CLI emitted malformed JSON output',
        {
          cause,
        },
      );
    }
  });
  return parts.join('');
}

function looksLikeStructuredJson(line: string): boolean {
  return line.startsWith('{') || line.startsWith('[');
}

function extractTextFromValue(value: unknown, fallbackText?: string): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (fallbackText !== undefined && (typeof value === 'number' || typeof value === 'boolean')) {
    return [fallbackText];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child) => extractTextFromValue(child));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const type = record['type'];
  if (typeof type === 'string') {
    if (type === 'assistant.message_delta') {
      const data = record['data'];
      if (!data || typeof data !== 'object') {
        return [];
      }
      const deltaContent = (data as Record<string, unknown>)['deltaContent'];
      return typeof deltaContent === 'string' ? [deltaContent] : [];
    }
    return [];
  }

  for (const key of ['assistant_response', 'assistantResponse', 'delta', 'text', 'content']) {
    const child = record[key];
    if (typeof child === 'string') {
      return [child];
    }
  }

  return [];
}
