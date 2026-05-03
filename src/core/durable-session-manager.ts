import { realpath } from 'node:fs/promises';

import { type LoggerInterface, NoopLogger } from '../logging/logger';
import { AgentLoomError, toAgentLoomError } from './errors';
import type {
  AgentBackendInterface,
  AgentEvent,
  AgentRequestInputInterface,
  ApprovalDecision,
  ApprovalEvaluation,
  ApprovalProviderInterface,
  BackendSessionInterface,
  CancelResultInterface,
  RequestContextInterface,
  ResolvedTurnInterface,
  SessionManagerInterface,
  StateStoreInterface,
  ThreadInterface,
  TurnRecordInterface,
} from './types';

const TERMINAL_TURN_TYPES = new Set<AgentEvent['type']>([
  'turn.succeeded',
  'turn.failed',
  'turn.cancelled',
  'turn.interrupted',
]);
const DEFAULT_CANCEL_TIMEOUT_MS = 1000;

export class DurableSessionManager implements SessionManagerInterface {
  readonly #store: StateStoreInterface;
  readonly #backend: AgentBackendInterface;
  readonly #approvalProvider: ApprovalProviderInterface | undefined;
  readonly #cancelTimeoutMs: number;
  readonly #events = new Map<string, AgentEvent[]>();

  constructor(options: {
    store: StateStoreInterface;
    backend: AgentBackendInterface;
    approvalProvider?: ApprovalProviderInterface;
    cancelTimeoutMs?: number;
    logger?: LoggerInterface;
  }) {
    this.#store = options.store;
    this.#backend = options.backend;
    this.#approvalProvider = options.approvalProvider;
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.#logger = (options.logger ?? new NoopLogger()).child({
      component: 'session-manager',
      backend: this.#backend.name,
    });
  }

  readonly #logger: LoggerInterface;

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
        protocol: input.clientRef.protocol,
        externalId: input.clientRef.externalId,
        turnId: turn.id,
        threadId: thread.id,
        ...(input.clientRef.parentExternalId
          ? {
              parentProtocol: input.clientRef.parentProtocol ?? input.clientRef.protocol,
              parentExternalId: input.clientRef.parentExternalId,
            }
          : {}),
      });
    }
    this.#events.set(turn.id, []);
    this.#logger.info(
      {
        event: 'turn.started',
        requestId: context.requestId,
        workspaceId: context.workspaceId,
        threadId: thread.id,
        turnId: turn.id,
        bridgeSessionId: session.bridgeSessionId,
        reusedThread: input.threadId !== undefined,
      },
      'turn started',
    );

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
      this.#logger.warn({ event: 'turn.cancel.not_found', turnId }, 'turn cancel target not found');
      return { status: 'not_found' as const };
    }
    if (isTerminalTurnStatus(turn.status)) {
      this.#logger.info(
        { event: 'turn.cancel.already_terminal', turnId, status: turn.status },
        'turn cancel skipped for terminal turn',
      );
      return { status: turn.status === 'cancelled' ? 'cancelled' : 'already_terminal' } as const;
    }
    const session = await this.#store.getBackendSession(turn.bridgeSessionId);
    if (!session) {
      this.#logger.warn(
        { event: 'turn.cancel.session_not_found', turnId, bridgeSessionId: turn.bridgeSessionId },
        'turn cancel backend session not found',
      );
      return { status: 'not_found' as const };
    }
    const thread = await this.#requireThread(turn.threadId);
    this.#assertSessionScope(session, {
      workspaceId: thread.workspaceId,
      threadId: turn.threadId,
    });
    const movedToCancelling = await this.#store.updateTurnStatus(
      turn.id,
      'any-non-terminal',
      'cancelling',
    );
    if (!movedToCancelling) {
      const currentTurn = await this.#store.getTurn(turn.id);
      if (currentTurn && isTerminalTurnStatus(currentTurn.status)) {
        return {
          status: currentTurn.status === 'cancelled' ? 'cancelled' : 'already_terminal',
        } as const;
      }
    }

    let cancelResult: CancelResultInterface;
    try {
      cancelResult = await this.#backend.cancel(session, {
        timeoutMs: this.#cancelTimeoutMs,
        forceAfterTimeout: true,
      });
    } catch (error) {
      const agentError = toAgentLoomError(error);
      await this.#store.updateTurnStatus(turn.id, 'cancelling', 'failed', Date.now());
      this.#appendEvent(turn.id, { type: 'turn.failed', turnId: turn.id, error });
      this.#logger.error(
        {
          event: 'turn.cancel.failed',
          turnId: turn.id,
          errorCode: agentError.code,
          error: agentError,
        },
        'turn cancel failed',
      );
      throw error;
    }

    if (cancelResult.status === 'timed_out') {
      await this.#backend.disposeSession(session);
      await this.#store.updateBackendSessionStatus(session.bridgeSessionId, 'any', 'abandoned');
      const interrupted = await this.#store.updateTurnStatus(
        turn.id,
        'cancelling',
        'interrupted',
        Date.now(),
      );
      if (interrupted) {
        this.#appendEvent(turn.id, {
          type: 'turn.interrupted',
          turnId: turn.id,
          reason: 'force_cancel_timeout_exceeded',
        });
      }
      this.#logger.warn(
        {
          event: 'turn.cancel.timed_out',
          turnId: turn.id,
          bridgeSessionId: session.bridgeSessionId,
        },
        'turn cancel timed out',
      );
      return { status: 'timed_out' as const };
    }

    const cancelled = await this.#store.updateTurnStatus(
      turn.id,
      'cancelling',
      'cancelled',
      Date.now(),
    );
    if (cancelled) {
      this.#appendEvent(turn.id, { type: 'turn.cancelled', turnId: turn.id });
    }
    this.#logger.info(
      { event: 'turn.cancelled', turnId: turn.id, bridgeSessionId: session.bridgeSessionId },
      'turn cancelled',
    );
    return { status: 'cancelled' as const };
  }

  async *streamTurn(
    resolved: ResolvedTurnInterface,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.#assertSessionScope(resolved.session, resolved.request);
    await this.#store.updateTurnStatus(resolved.turn.id, 'queued', 'running');
    const startedAt = Date.now();
    this.#logger.info(
      {
        event: 'turn.stream.started',
        workspaceId: resolved.request.workspaceId,
        threadId: resolved.thread.id,
        turnId: resolved.turn.id,
        bridgeSessionId: resolved.session.bridgeSessionId,
      },
      'turn stream started',
    );
    yield this.#record(resolved.turn.id, { type: 'turn.created', turnId: resolved.turn.id });

    let sawTerminal = false;
    let approvalTimeoutDeadline: number | null = null;
    const backendEvents = this.#backend.send(resolved.session, resolved.request, signal);
    const backendIterator = backendEvents[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = approvalTimeoutDeadline
          ? await nextWithDeadline(backendIterator, approvalTimeoutDeadline)
          : await backendIterator.next();
        if (next === 'timeout') {
          sawTerminal = true;
          void backendIterator.return?.();
          this.#logger.warn(
            {
              event: 'turn.stream.approval_timeout',
              turnId: resolved.turn.id,
              durationMs: Date.now() - startedAt,
            },
            'turn stream interrupted after approval timeout',
          );
          yield await this.#forceInterruptAfterApprovalTimeout(resolved);
          return;
        }
        if (next.done) {
          break;
        }
        const event = next.value;
        if (event.type === 'permission.required' && this.#approvalProvider) {
          yield this.#record(resolved.turn.id, event);
          const decision = await this.#resolveApprovalRequest(event, resolved, signal);
          yield this.#record(resolved.turn.id, {
            type: 'permission.resolved',
            turnId: resolved.turn.id,
            approvalId: event.approvalId,
            decision: decision.type === 'allow' ? 'allow' : 'deny',
          });
          if (decision.type === 'timeout') {
            approvalTimeoutDeadline = Date.now() + this.#cancelTimeoutMs;
          }
          continue;
        }
        if (TERMINAL_TURN_TYPES.has(event.type)) {
          sawTerminal = true;
          approvalTimeoutDeadline = null;
          await this.#store.updateTurnStatus(
            resolved.turn.id,
            'any-non-terminal',
            statusForTerminalEvent(event),
            Date.now(),
          );
          this.#logger.info(
            {
              event: 'turn.stream.terminal',
              turnId: resolved.turn.id,
              terminalType: event.type,
              durationMs: Date.now() - startedAt,
            },
            'turn stream terminal event',
          );
        }
        yield this.#record(resolved.turn.id, event);
      }
    } catch (error) {
      const agentError = toAgentLoomError(error);
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
      this.#logger.error(
        {
          event: 'turn.stream.failed',
          turnId: resolved.turn.id,
          durationMs: Date.now() - startedAt,
          errorCode: agentError.code,
          error: agentError,
        },
        'turn stream failed',
      );
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
      this.#logger.warn(
        {
          event: 'turn.stream.interrupted',
          turnId: resolved.turn.id,
          durationMs: Date.now() - startedAt,
          reason: 'backend_ended_without_terminal_event',
        },
        'turn stream interrupted',
      );
    }
  }

  async #forceInterruptAfterApprovalTimeout(resolved: ResolvedTurnInterface): Promise<AgentEvent> {
    await this.#store.updateTurnStatus(resolved.turn.id, 'any-non-terminal', 'cancelling');
    const cancelResult = await this.#backend.cancel(resolved.session, {
      timeoutMs: this.#cancelTimeoutMs,
      forceAfterTimeout: true,
    });
    if (cancelResult.status === 'timed_out') {
      await this.#backend.disposeSession(resolved.session);
      await this.#store.updateBackendSessionStatus(
        resolved.session.bridgeSessionId,
        'any',
        'abandoned',
      );
    }
    await this.#store.updateTurnStatus(
      resolved.turn.id,
      'any-non-terminal',
      'interrupted',
      Date.now(),
    );
    return this.#record(resolved.turn.id, {
      type: 'turn.interrupted',
      turnId: resolved.turn.id,
      reason: 'approval_timeout_exceeded',
    });
  }

  async #requireThread(threadId: string): Promise<ThreadInterface> {
    const thread = await this.#store.getThread(threadId);
    if (!thread) {
      throw new AgentLoomError('thread_not_found', 'Thread was not found');
    }
    return thread;
  }

  async #createSessionForThread(thread: ThreadInterface): Promise<BackendSessionInterface> {
    const workspace = await this.#requireWorkspace(thread.workspaceId);
    const reserved = await this.#store.reserveBackendSession({
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      backend: this.#backend.name,
    });
    try {
      const created = await this.#backend.createSession(workspace, {
        bridgeSessionId: reserved.bridgeSessionId,
        threadId: thread.id,
      });
      await this.#store.activateBackendSession(reserved, {
        backendSessionId: created.backendSessionId ?? reserved.bridgeSessionId,
      });
      this.#logger.info(
        {
          event: 'backend.session.created',
          workspaceId: thread.workspaceId,
          threadId: thread.id,
          bridgeSessionId: reserved.bridgeSessionId,
          backendSessionId: created.backendSessionId ?? reserved.bridgeSessionId,
        },
        'backend session created',
      );
      return (await this.#store.getBackendSession(reserved.bridgeSessionId)) ?? created;
    } catch (error) {
      const agentError = toAgentLoomError(error);
      await this.#store.updateBackendSessionStatus(
        reserved.bridgeSessionId,
        'initializing',
        'lost',
      );
      this.#logger.error(
        {
          event: 'backend.session.create_failed',
          workspaceId: thread.workspaceId,
          threadId: thread.id,
          bridgeSessionId: reserved.bridgeSessionId,
          errorCode: agentError.code,
          error: agentError,
        },
        'backend session creation failed',
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
    const resumed = await this.#backend.resumeSession(session);
    this.#logger.info(
      {
        event: 'backend.session.resumed',
        workspaceId,
        threadId,
        bridgeSessionId: session.bridgeSessionId,
        backendSessionId: session.backendSessionId,
      },
      'backend session resumed',
    );
    return resumed;
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
    const workspace = await this.#requireWorkspace(workspaceId);
    try {
      const canonicalRoot = await realpath(workspace.rootPath);
      if (canonicalRoot !== workspace.rootPath) {
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

  async #requireWorkspace(workspaceId: string) {
    const workspace = await this.#store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new AgentLoomError('workspace_changed', 'Workspace is no longer available');
    }
    return workspace;
  }

  async #resolveApprovalRequest(
    event: Extract<AgentEvent, { type: 'permission.required' }>,
    resolved: ResolvedTurnInterface,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (!this.#approvalProvider) {
      throw new AgentLoomError('approval_provider_missing', 'No approval provider is configured');
    }
    const workspace = await this.#requireWorkspace(resolved.request.workspaceId);
    const evaluation = await this.#approvalProvider.evaluate(event.request, {
      turnId: resolved.turn.id,
      threadId: resolved.thread.id,
      workspaceId: resolved.request.workspaceId,
      workspaceRootPath: workspace.rootPath,
      bridgeSessionId: resolved.session.bridgeSessionId,
      approvalId: event.approvalId,
    });
    this.#logger.info(
      {
        event: 'approval.evaluated',
        turnId: resolved.turn.id,
        threadId: resolved.thread.id,
        approvalId: event.approvalId,
        evaluation: evaluation.type,
        action: event.request.action,
      },
      'approval evaluated',
    );
    const decision = await this.#decisionFromEvaluation(evaluation, signal);
    this.#logger.info(
      {
        event: 'approval.decided',
        turnId: resolved.turn.id,
        threadId: resolved.thread.id,
        approvalId: event.approvalId,
        decision: decision.type,
      },
      'approval decided',
    );
    await this.#deliverApprovalDecision(resolved.session, event.approvalId, decision);
    return decision;
  }

  async #decisionFromEvaluation(
    evaluation: ApprovalEvaluation,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    switch (evaluation.type) {
      case 'allow':
        return { type: 'allow', scope: 'once' };
      case 'deny':
        return { type: 'deny', scope: 'once', reason: evaluation.reason };
      case 'ask':
        if (!this.#approvalProvider) {
          throw new AgentLoomError(
            'approval_provider_missing',
            'No approval provider is configured',
          );
        }
        return await this.#approvalProvider.awaitDecision(evaluation.approvalId, signal);
    }
  }

  async #deliverApprovalDecision(
    session: BackendSessionInterface,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const capabilities = this.#backend.capabilities();
    if (!capabilities.externalApprovalDecisions || !this.#backend.submitApprovalDecision) {
      throw new AgentLoomError(
        'approval_delivery_unsupported',
        'Backend does not support external approval decision delivery',
      );
    }
    await this.#backend.submitApprovalDecision(session, approvalId, decision);
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

async function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  deadline: number,
): Promise<IteratorResult<T> | 'timeout'> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return 'timeout';
  }
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), remainingMs),
  );
  return await Promise.race([iterator.next(), timeout]);
}
