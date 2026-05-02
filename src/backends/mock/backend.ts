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

export class MockBackend implements AgentBackendInterface {
  readonly name = 'mock';
  readonly #capabilities: BackendCapabilitiesInterface;

  constructor(capabilities: Partial<BackendCapabilitiesInterface> = {}) {
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

  capabilities(): BackendCapabilitiesInterface {
    return this.#capabilities;
  }

  async createSession(
    workspace: WorkspaceInterface,
    options: CreateSessionOptionsInterface,
  ): Promise<BackendSessionInterface> {
    return {
      bridgeSessionId: options.bridgeSessionId,
      backendSessionId: `mock_${options.bridgeSessionId}`,
      workspaceId: workspace.id,
      threadId: options.threadId,
      status: 'active',
    };
  }

  async *send(
    session: BackendSessionInterface,
    request: AgentRequestInterface,
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
    };
  }

  async cancel(
    _session: BackendSessionInterface,
    _options?: CancelOptionsInterface,
  ): Promise<CancelResultInterface> {
    return { status: 'cancelled' };
  }

  async disposeSession(_session: BackendSessionInterface): Promise<void> {}
}
