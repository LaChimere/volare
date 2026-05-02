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
    const backendSessionId = `copilot_cli_${options.bridgeSessionId}`;
    this.#workspaceRoots.set(backendSessionId, workspace.rootPath);
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

export class BunCopilotPromptRunner implements CopilotPromptRunnerInterface {
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

    const abort = () => proc.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new AgentLoomError('backend_process_failed', `Copilot CLI exited with ${exitCode}`, {
          cause: stderr,
        });
      }

      const text = extractTextFromCopilotOutput(stdout);
      if (text.length > 0) {
        yield text;
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
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
