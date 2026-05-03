import type {
  AgentEvent,
  IAgentBackend,
  IAgentRequest,
  IBackendCapabilities,
  IBackendSession,
  ICancelOptions,
  ICancelResult,
  ICreateSessionOptions,
  IWorkspace,
} from '../../../src/core/types';
import { createEstimatedUsage } from '../../../src/core/usage';

export class MockBackend implements IAgentBackend {
  readonly name = 'mock';
  readonly #capabilities: IBackendCapabilities;

  constructor(capabilities: Partial<IBackendCapabilities> = {}) {
    this.#capabilities = {
      persistentSessions: false,
      serverSideTools: false,
      permissionRequests: true,
      externalApprovalDecisions: false,
      backendInternalPauseResume: true,
      cancellation: true,
      ...capabilities,
    };
  }

  capabilities(): IBackendCapabilities {
    return this.#capabilities;
  }

  async createSession(
    workspace: IWorkspace,
    options: ICreateSessionOptions,
  ): Promise<IBackendSession> {
    return {
      bridgeSessionId: options.bridgeSessionId,
      backendSessionId: `mock_${options.bridgeSessionId}`,
      workspaceId: workspace.id,
      threadId: options.threadId,
      status: 'active',
    };
  }

  async resumeSession(session: IBackendSession): Promise<IBackendSession> {
    return session;
  }

  async *send(
    session: IBackendSession,
    request: IAgentRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (session.workspaceId !== request.workspaceId || session.threadId !== request.threadId) {
      yield {
        type: 'turn.failed',
        turnId: request.turnId,
        error: { code: 'backend_session_mismatch' },
      };
      return;
    }

    if (signal?.aborted) {
      yield { type: 'turn.cancelled', turnId: request.turnId };
      return;
    }

    yield { type: 'text.delta', turnId: request.turnId, delta: request.input.message };
    yield {
      type: 'turn.succeeded',
      turnId: request.turnId,
      output: { text: request.input.message },
      usage: createEstimatedUsage(request.input.message, request.input.message),
    };
  }

  async cancel(_session: IBackendSession, _options?: ICancelOptions): Promise<ICancelResult> {
    return { status: 'cancelled' };
  }

  async disposeSession(_session: IBackendSession): Promise<void> {}
}
