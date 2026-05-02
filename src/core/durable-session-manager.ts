import { realpath } from 'node:fs/promises';

import { AgentLoomError } from './errors';
import type {
  AgentBackendInterface,
  AgentEvent,
  AgentRequestInputInterface,
  BackendSessionInterface,
  RequestContextInterface,
  ResolvedTurnInterface,
  SessionManagerInterface,
  StateStoreInterface,
  ThreadInterface,
  TurnRecordInterface,
  WorkspaceInterface,
} from './types';

const TERMINAL_TURN_TYPES = new Set<AgentEvent['type']>([
  'turn.succeeded',
  'turn.failed',
  'turn.cancelled',
  'turn.interrupted',
]);

export class DurableSessionManager implements SessionManagerInterface {
  readonly #store: StateStoreInterface;
  readonly #backend: AgentBackendInterface;
  readonly #workspace: WorkspaceInterface;
  readonly #events = new Map<string, AgentEvent[]>();

  constructor(options: {
    store: StateStoreInterface;
    backend: AgentBackendInterface;
    workspace: WorkspaceInterface;
  }) {
    this.#store = options.store;
    this.#backend = options.backend;
    this.#workspace = options.workspace;
  }

  async startTurn(
    input: AgentRequestInputInterface,
    context: RequestContextInterface,
  ): Promise<ResolvedTurnInterface> {
    const thread = input.threadId
      ? await this.#requireThread(input.threadId)
      : await this.#store.createThread({ workspaceId: context.workspaceId });
    if (thread.workspaceId !== context.workspaceId) {
      throw new AgentLoomError('workspace_mismatch', 'Thread belongs to a different workspace');
    }

    const session = input.threadId
      ? await this.#resumeSessionForThread(input.threadId, context.workspaceId)
      : await this.#createSessionForThread(thread);

    const turnInput = {
      threadId: thread.id,
      bridgeSessionId: session.bridgeSessionId,
      model: input.model,
      ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
    };
    const turn = await this.#store.createTurn(turnInput);
    if (input.clientRef?.externalId) {
      await this.#store.bindClientRef({
        protocol: 'openai-responses-v1',
        externalId: input.clientRef.externalId,
        turnId: turn.id,
        threadId: thread.id,
        ...(input.clientRef.parentExternalId
          ? {
              parentProtocol: 'openai-responses-v1',
              parentExternalId: input.clientRef.parentExternalId,
            }
          : {}),
      });
    }
    this.#events.set(turn.id, []);

    return {
      turn,
      thread,
      session,
      ...(input.clientRef?.externalId ? { externalResponseId: input.clientRef.externalId } : {}),
      request: {
        turnId: turn.id,
        threadId: thread.id,
        workspaceId: context.workspaceId,
        input: input.input,
        model: input.model,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    };
  }

  async getTurn(turnId: string): Promise<TurnRecordInterface | null> {
    return await this.#store.getTurn(turnId);
  }

  getEvents(turnId: string): AgentEvent[] {
    return [...(this.#events.get(turnId) ?? [])];
  }

  async cancelTurn(turnId: string) {
    const turn = await this.#store.getTurn(turnId);
    if (!turn) {
      return { status: 'not_found' as const };
    }
    if (isTerminalTurnStatus(turn.status)) {
      return { status: 'cancelled' as const };
    }
    const session = await this.#store.getBackendSession(turn.bridgeSessionId);
    if (!session) {
      return { status: 'not_found' as const };
    }
    const thread = await this.#requireThread(turn.threadId);
    this.#assertSessionScope(session, {
      workspaceId: thread.workspaceId,
      threadId: turn.threadId,
    });
    await this.#backend.cancel(session, { timeoutMs: 0, forceAfterTimeout: false });
    const moved = await this.#store.updateTurnStatus(
      turn.id,
      'any-non-terminal',
      'cancelled',
      Date.now(),
    );
    if (moved) {
      this.#appendEvent(turn.id, { type: 'turn.cancelled', turnId: turn.id });
    }
    return { status: 'cancelled' as const };
  }

  async *streamTurn(
    resolved: ResolvedTurnInterface,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.#assertSessionScope(resolved.session, resolved.request);
    await this.#store.updateTurnStatus(resolved.turn.id, 'queued', 'running');
    yield this.#record(resolved.turn.id, { type: 'turn.created', turnId: resolved.turn.id });

    let sawTerminal = false;
    try {
      for await (const event of this.#backend.send(resolved.session, resolved.request, signal)) {
        if (TERMINAL_TURN_TYPES.has(event.type)) {
          sawTerminal = true;
          await this.#store.updateTurnStatus(
            resolved.turn.id,
            'any-non-terminal',
            statusForTerminalEvent(event),
            Date.now(),
          );
        }
        yield this.#record(resolved.turn.id, event);
      }
    } catch (error) {
      sawTerminal = true;
      await this.#store.updateTurnStatus(
        resolved.turn.id,
        'any-non-terminal',
        'failed',
        Date.now(),
      );
      yield this.#record(resolved.turn.id, {
        type: 'turn.failed',
        turnId: resolved.turn.id,
        error,
      });
    }

    if (!sawTerminal) {
      await this.#store.updateTurnStatus(
        resolved.turn.id,
        'any-non-terminal',
        'interrupted',
        Date.now(),
      );
      yield this.#record(resolved.turn.id, {
        type: 'turn.interrupted',
        turnId: resolved.turn.id,
        reason: 'backend_ended_without_terminal_event',
      });
    }
  }

  async #requireThread(threadId: string): Promise<ThreadInterface> {
    const thread = await this.#store.getThread(threadId);
    if (!thread) {
      throw new AgentLoomError('thread_not_found', 'Thread was not found');
    }
    return thread;
  }

  async #createSessionForThread(thread: ThreadInterface): Promise<BackendSessionInterface> {
    const reserved = await this.#store.reserveBackendSession({
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      backend: this.#backend.name,
    });
    try {
      const created = await this.#backend.createSession(this.#workspace, {
        bridgeSessionId: reserved.bridgeSessionId,
        threadId: thread.id,
      });
      await this.#store.activateBackendSession(reserved, {
        backendSessionId: created.backendSessionId ?? reserved.bridgeSessionId,
      });
      return (await this.#store.getBackendSession(reserved.bridgeSessionId)) ?? created;
    } catch (error) {
      await this.#store.updateBackendSessionStatus(
        reserved.bridgeSessionId,
        'initializing',
        'lost',
      );
      throw error;
    }
  }

  async #resumeSessionForThread(
    threadId: string,
    workspaceId: string,
  ): Promise<BackendSessionInterface> {
    const session = await this.#store.getBackendSessionByThread(threadId);
    if (!session) {
      throw new AgentLoomError('session_lost', 'No active backend session exists for this thread');
    }
    this.#assertSessionScope(session, { workspaceId, threadId });
    await this.#assertWorkspaceUnchanged(workspaceId);
    return await this.#backend.resumeSession(session);
  }

  #assertSessionScope(
    session: BackendSessionInterface,
    request: { workspaceId: string; threadId: string },
  ): void {
    if (session.workspaceId !== request.workspaceId || session.threadId !== request.threadId) {
      throw new AgentLoomError(
        'backend_session_mismatch',
        'Backend session does not match request scope',
      );
    }
  }

  async #assertWorkspaceUnchanged(workspaceId: string): Promise<void> {
    const workspace = await this.#store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new AgentLoomError('workspace_changed', 'Workspace is no longer available');
    }
    try {
      const canonicalRoot = await realpath(workspace.rootPath);
      if (canonicalRoot !== workspace.rootPath || workspace.rootPath !== this.#workspace.rootPath) {
        throw new AgentLoomError('workspace_changed', 'Workspace root changed before resume');
      }
    } catch (cause) {
      if (cause instanceof AgentLoomError) {
        throw cause;
      }
      throw new AgentLoomError('workspace_changed', 'Workspace root changed before resume', {
        cause,
      });
    }
  }

  #record(turnId: string, event: AgentEvent): AgentEvent {
    this.#appendEvent(turnId, event);
    return event;
  }

  #appendEvent(turnId: string, event: AgentEvent): void {
    const events = this.#events.get(turnId);
    if (!events) {
      this.#events.set(turnId, [event]);
      return;
    }
    events.push(event);
  }
}

function statusForTerminalEvent(event: AgentEvent): TurnRecordInterface['status'] {
  switch (event.type) {
    case 'turn.succeeded':
      return 'succeeded';
    case 'turn.failed':
      return 'failed';
    case 'turn.cancelled':
      return 'cancelled';
    case 'turn.interrupted':
      return 'interrupted';
    default:
      return 'failed';
  }
}

function isTerminalTurnStatus(status: TurnRecordInterface['status']): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}
