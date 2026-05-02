import { MockBackend } from '../backends/mock/backend';
import { AgentLoomError } from './errors';
import { createId } from './ids';
import type {
  AgentBackendInterface,
  AgentEvent,
  AgentRequestInputInterface,
  CancelResultInterface,
  RequestContextInterface,
  ResolvedTurnInterface,
  ThreadInterface,
  TurnRecordInterface,
  WorkspaceInterface,
} from './types';

export class InMemorySessionManager {
  readonly #backend: AgentBackendInterface;
  readonly #workspace: WorkspaceInterface;
  readonly #turns = new Map<string, TurnRecordInterface>();
  readonly #events = new Map<string, AgentEvent[]>();

  constructor(options: { backend?: AgentBackendInterface; workspace: WorkspaceInterface }) {
    this.#backend = options.backend ?? new MockBackend();
    this.#workspace = options.workspace;
  }

  async startTurn(
    input: AgentRequestInputInterface,
    context: RequestContextInterface,
  ): Promise<ResolvedTurnInterface> {
    if (input.threadId || input.parentTurnId || input.clientRef?.parentExternalId) {
      throw new AgentLoomError(
        'unsupported_parameter',
        'previous_response_id is not supported until durable multi-turn state lands',
      );
    }

    const thread: ThreadInterface = {
      id: createId('thread'),
      workspaceId: context.workspaceId,
    };
    const bridgeSessionId = createId('bridge_session');
    const session = await this.#backend.createSession(this.#workspace, {
      bridgeSessionId,
      threadId: thread.id,
      model: input.model,
    });
    const turn: TurnRecordInterface = {
      id: input.clientRef?.externalId ?? createId('resp'),
      threadId: thread.id,
      parentTurnId: null,
      bridgeSessionId: session.bridgeSessionId,
      status: 'queued',
      model: input.model,
      createdAt: new Date(),
    };
    const request = {
      turnId: turn.id,
      threadId: thread.id,
      workspaceId: context.workspaceId,
      input: input.input,
      model: input.model,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    this.#turns.set(turn.id, turn);
    this.#events.set(turn.id, []);

    return {
      turn,
      thread,
      session,
      request,
    };
  }

  getTurn(turnId: string): TurnRecordInterface | null {
    return this.#turns.get(turnId) ?? null;
  }

  getEvents(turnId: string): AgentEvent[] {
    return [...(this.#events.get(turnId) ?? [])];
  }

  async cancelTurn(turnId: string): Promise<CancelResultInterface> {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return { status: 'not_found' };
    }

    if (
      turn.status === 'succeeded' ||
      turn.status === 'failed' ||
      turn.status === 'cancelled' ||
      turn.status === 'interrupted'
    ) {
      return { status: 'cancelled' };
    }

    this.#replaceTurn({
      ...turn,
      status: 'cancelled',
      completedAt: new Date(),
    });
    this.#appendEvent(turn.id, { type: 'turn.cancelled', turnId });
    return { status: 'cancelled' };
  }

  async *streamTurn(
    resolved: ResolvedTurnInterface,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.#replaceTurn({ ...resolved.turn, status: 'running' });
    yield this.#record(resolved.turn.id, { type: 'turn.created', turnId: resolved.turn.id });

    let sawTerminal = false;
    try {
      for await (const event of this.#backend.send(resolved.session, resolved.request, signal)) {
        if (this.#isTerminal(event)) {
          sawTerminal = true;
          this.#replaceTurn({
            ...this.#requireTurn(resolved.turn.id),
            status: this.#statusForTerminalEvent(event),
            completedAt: new Date(),
          });
        }
        yield this.#record(resolved.turn.id, event);
      }
    } catch (error) {
      sawTerminal = true;
      const failedEvent: AgentEvent = {
        type: 'turn.failed',
        turnId: resolved.turn.id,
        error,
      };
      this.#replaceTurn({
        ...this.#requireTurn(resolved.turn.id),
        status: 'failed',
        completedAt: new Date(),
      });
      yield this.#record(resolved.turn.id, failedEvent);
    }

    if (!sawTerminal) {
      const interruptedEvent: AgentEvent = {
        type: 'turn.interrupted',
        turnId: resolved.turn.id,
        reason: 'backend_ended_without_terminal_event',
      };
      this.#replaceTurn({
        ...this.#requireTurn(resolved.turn.id),
        status: 'interrupted',
        completedAt: new Date(),
      });
      yield this.#record(resolved.turn.id, interruptedEvent);
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

  #replaceTurn(turn: TurnRecordInterface): void {
    this.#turns.set(turn.id, turn);
  }

  #requireTurn(turnId: string): TurnRecordInterface {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      throw new Error(`Turn not found: ${turnId}`);
    }
    return turn;
  }

  #isTerminal(event: AgentEvent): boolean {
    return (
      event.type === 'turn.succeeded' ||
      event.type === 'turn.failed' ||
      event.type === 'turn.cancelled' ||
      event.type === 'turn.interrupted'
    );
  }

  #statusForTerminalEvent(event: AgentEvent): TurnRecordInterface['status'] {
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
}
