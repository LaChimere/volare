import { realpath } from 'node:fs/promises';

import { type ILogger, NoopLogger } from '../logging/logger';
import { toVolareError, VolareError } from './errors';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalEvaluation,
  IAgentBackend,
  IAgentRequestInput,
  IApprovalProvider,
  IBackendSession,
  ICancelResult,
  IRequestContext,
  IResolvedTurn,
  ISessionManager,
  IStateStore,
  IThread,
  ITurnRecord,
} from './types';

const TERMINAL_TURN_TYPES = new Set<AgentEvent['type']>([
  'turn.succeeded',
  'turn.failed',
  'turn.cancelled',
  'turn.interrupted',
]);
const DEFAULT_CANCEL_TIMEOUT_MS = 1000;
const DEFAULT_MAX_ACTIVE_TURNS = Number.POSITIVE_INFINITY;

export class DurableSessionManager implements ISessionManager {
  readonly #store: IStateStore;
  readonly #backend: IAgentBackend;
  readonly #approvalProvider: IApprovalProvider | undefined;
  readonly #cancelTimeoutMs: number;
  readonly #maxActiveTurns: number;
  readonly #events = new Map<string, AgentEvent[]>();
  readonly #activeTurnIds = new Set<string>();
  #activeTurnCount = 0;

  constructor(options: {
    store: IStateStore;
    backend: IAgentBackend;
    approvalProvider?: IApprovalProvider;
    cancelTimeoutMs?: number;
    maxActiveTurns?: number;
    logger?: ILogger;
  }) {
    this.#store = options.store;
    this.#backend = options.backend;
    this.#approvalProvider = options.approvalProvider;
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.#maxActiveTurns = options.maxActiveTurns ?? DEFAULT_MAX_ACTIVE_TURNS;
    this.#logger = (options.logger ?? new NoopLogger()).child({
      component: 'session-manager',
      backend: this.#backend.name,
    });
  }

  readonly #logger: ILogger;

  async startTurn(input: IAgentRequestInput, context: IRequestContext): Promise<IResolvedTurn> {
    this.#reserveActiveTurnCapacity();
    let reservedTurnId: string | undefined;
    const startedAt = performance.now();
    let phaseStartedAt = performance.now();
    try {
      const thread = input.threadId
        ? await this.#requireThread(input.threadId)
        : await this.#store.createThread({ workspaceId: context.workspaceId });
      const threadResolveMs = elapsedMs(phaseStartedAt);
      if (thread.workspaceId !== context.workspaceId) {
        throw new VolareError('workspace_mismatch', 'Thread belongs to a different workspace');
      }

      phaseStartedAt = performance.now();
      const session = input.threadId
        ? await this.#resumeSessionForThread(input.threadId, context.workspaceId)
        : await this.#createSessionForThread(thread);
      const backendSessionResolveMs = elapsedMs(phaseStartedAt);

      phaseStartedAt = performance.now();
      const turnInput = {
        threadId: thread.id,
        bridgeSessionId: session.bridgeSessionId,
        model: input.model,
        ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
      };
      const turn = await this.#store.createTurn(turnInput);
      reservedTurnId = turn.id;
      this.#activeTurnIds.add(turn.id);
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
      const turnPersistMs = elapsedMs(phaseStartedAt);
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
          activeTurnCount: this.#activeTurnCount,
          maxActiveTurns: Number.isFinite(this.#maxActiveTurns) ? this.#maxActiveTurns : null,
          stateStartMs: elapsedMs(startedAt),
          threadResolveMs,
          backendSessionResolveMs,
          turnPersistMs,
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
    } catch (error) {
      if (reservedTurnId) {
        this.#releaseActiveTurn(reservedTurnId);
      } else {
        this.#releaseUntrackedActiveTurnCapacity();
      }
      throw error;
    }
  }

  async getTurn(turnId: string): Promise<ITurnRecord | null> {
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
      this.#releaseActiveTurn(turnId);
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

    let cancelResult: ICancelResult;
    try {
      cancelResult = await this.#backend.cancel(session, {
        timeoutMs: this.#cancelTimeoutMs,
        forceAfterTimeout: true,
      });
    } catch (error) {
      const agentError = toVolareError(error);
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
      await this.#markTurnFailedAfterError(turn.id, error, 'turn.cancel.cleanup_failed');
      this.#releaseActiveTurn(turn.id);
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
      this.#releaseActiveTurn(turn.id);
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
    this.#releaseActiveTurn(turn.id);
    return { status: 'cancelled' as const };
  }

  async *streamTurn(resolved: IResolvedTurn, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const startedAt = performance.now();
    let canonicalEventCount = 0;
    const record = (event: AgentEvent): AgentEvent => {
      canonicalEventCount += 1;
      return this.#record(resolved.turn.id, event);
    };
    try {
      this.#assertSessionScope(resolved.session, resolved.request);
      await this.#store.updateTurnStatus(resolved.turn.id, 'queued', 'running');
      this.#logger.info(
        {
          event: 'turn.stream.started',
          workspaceId: resolved.request.workspaceId,
          threadId: resolved.thread.id,
          turnId: resolved.turn.id,
          bridgeSessionId: resolved.session.bridgeSessionId,
          activeTurnCount: this.#activeTurnCount,
        },
        'turn stream started',
      );
      yield record({
        type: 'turn.created',
        turnId: resolved.turn.id,
        ...(resolved.request.metadata ? { requestMetadata: resolved.request.metadata } : {}),
      });

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
                durationMs: elapsedMs(startedAt),
                activeTurnCount: this.#activeTurnCount,
                canonicalEventCount,
              },
              'turn stream interrupted after approval timeout',
            );
            const interrupted = await this.#forceInterruptAfterApprovalTimeout(resolved);
            canonicalEventCount += 1;
            yield interrupted;
            return;
          }
          if (next.done) {
            break;
          }
          const event = next.value;
          if (event.type === 'permission.required' && this.#approvalProvider) {
            yield record(event);
            const decision = await this.#resolveApprovalRequest(event, resolved, signal);
            yield record({
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
                durationMs: elapsedMs(startedAt),
                activeTurnCount: this.#activeTurnCount,
                canonicalEventCount: canonicalEventCount + 1,
              },
              'turn stream terminal event',
            );
            this.#releaseActiveTurn(resolved.turn.id);
          }
          yield record(event);
        }
      } catch (error) {
        const agentError = toVolareError(error);
        sawTerminal = true;
        yield record({
          type: 'turn.failed',
          turnId: resolved.turn.id,
          error,
        });
        this.#logger.error(
          {
            event: 'turn.stream.failed',
            turnId: resolved.turn.id,
            durationMs: elapsedMs(startedAt),
            activeTurnCount: this.#activeTurnCount,
            canonicalEventCount,
            errorCode: agentError.code,
          },
          'turn stream failed',
        );
        await this.#markTurnFailedAfterError(resolved.turn.id, error, 'turn.stream.cleanup_failed');
      }

      if (!sawTerminal) {
        await this.#store.updateTurnStatus(
          resolved.turn.id,
          'any-non-terminal',
          'interrupted',
          Date.now(),
        );
        const interrupted = record({
          type: 'turn.interrupted',
          turnId: resolved.turn.id,
          reason: 'backend_ended_without_terminal_event',
        });
        this.#logger.warn(
          {
            event: 'turn.stream.interrupted',
            turnId: resolved.turn.id,
            durationMs: elapsedMs(startedAt),
            activeTurnCount: this.#activeTurnCount,
            canonicalEventCount,
            reason: 'backend_ended_without_terminal_event',
          },
          'turn stream interrupted',
        );
        yield interrupted;
      }
    } finally {
      this.#releaseActiveTurn(resolved.turn.id);
    }
  }

  async #forceInterruptAfterApprovalTimeout(resolved: IResolvedTurn): Promise<AgentEvent> {
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

  async #requireThread(threadId: string): Promise<IThread> {
    const thread = await this.#store.getThread(threadId);
    if (!thread) {
      throw new VolareError('thread_not_found', 'Thread was not found');
    }
    return thread;
  }

  async #createSessionForThread(thread: IThread): Promise<IBackendSession> {
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
      const agentError = toVolareError(error);
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
      try {
        await this.#store.updateBackendSessionStatus(
          reserved.bridgeSessionId,
          'initializing',
          'lost',
        );
      } catch (cleanupError) {
        const cleanupAgentError = toVolareError(cleanupError);
        this.#logger.error(
          {
            event: 'backend.session.create_cleanup_failed',
            workspaceId: thread.workspaceId,
            threadId: thread.id,
            bridgeSessionId: reserved.bridgeSessionId,
            errorCode: cleanupAgentError.code,
            error: cleanupAgentError,
          },
          'backend session creation cleanup failed',
        );
      }
      throw error;
    }
  }

  async #resumeSessionForThread(threadId: string, workspaceId: string): Promise<IBackendSession> {
    const session = await this.#store.getBackendSessionByThread(threadId);
    if (!session) {
      throw new VolareError('session_lost', 'No active backend session exists for this thread');
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
    session: IBackendSession,
    request: { workspaceId: string; threadId: string },
  ): void {
    if (session.workspaceId !== request.workspaceId || session.threadId !== request.threadId) {
      throw new VolareError(
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
        throw new VolareError('workspace_changed', 'Workspace root changed before resume');
      }
    } catch (cause) {
      if (cause instanceof VolareError) {
        throw cause;
      }
      throw new VolareError('workspace_changed', 'Workspace root changed before resume', {
        cause,
      });
    }
  }

  async #requireWorkspace(workspaceId: string) {
    const workspace = await this.#store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new VolareError('workspace_changed', 'Workspace is no longer available');
    }
    return workspace;
  }

  async #resolveApprovalRequest(
    event: Extract<AgentEvent, { type: 'permission.required' }>,
    resolved: IResolvedTurn,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (!this.#approvalProvider) {
      throw new VolareError('approval_provider_missing', 'No approval provider is configured');
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
          throw new VolareError('approval_provider_missing', 'No approval provider is configured');
        }
        return await this.#approvalProvider.awaitDecision(evaluation.approvalId, signal);
    }
  }

  async #deliverApprovalDecision(
    session: IBackendSession,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const capabilities = this.#backend.capabilities();
    if (!capabilities.externalApprovalDecisions || !this.#backend.submitApprovalDecision) {
      throw new VolareError(
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

  #reserveActiveTurnCapacity(): void {
    if (this.#activeTurnCount >= this.#maxActiveTurns) {
      throw new VolareError('capacity_exhausted', 'Active turn capacity is exhausted', {
        cause: {
          scope: 'active_turns',
          limit: Number.isFinite(this.#maxActiveTurns) ? this.#maxActiveTurns : null,
          activeTurnCount: this.#activeTurnCount,
          retryAfterMs: 1000,
        },
      });
    }
    this.#activeTurnCount += 1;
  }

  #releaseActiveTurn(turnId: string): void {
    if (!this.#activeTurnIds.delete(turnId)) {
      return;
    }
    this.#activeTurnCount = Math.max(0, this.#activeTurnCount - 1);
  }

  #releaseUntrackedActiveTurnCapacity(): void {
    this.#activeTurnCount = Math.max(0, this.#activeTurnCount - 1);
  }

  #appendEvent(turnId: string, event: AgentEvent): void {
    const events = this.#events.get(turnId);
    if (!events) {
      this.#events.set(turnId, [event]);
      return;
    }
    events.push(event);
  }

  async #markTurnFailedAfterError(
    turnId: string,
    originalError: unknown,
    cleanupEvent: string,
  ): Promise<void> {
    try {
      await this.#store.updateTurnStatus(turnId, 'any-non-terminal', 'failed', Date.now());
    } catch (cleanupError) {
      const cleanupAgentError = toVolareError(cleanupError);
      this.#logger.error(
        {
          event: cleanupEvent,
          turnId,
          originalErrorCode: toVolareError(originalError).code,
          errorCode: cleanupAgentError.code,
          error: cleanupAgentError,
        },
        'turn failure cleanup failed',
      );
    }
  }
}

function statusForTerminalEvent(event: AgentEvent): ITurnRecord['status'] {
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

function isTerminalTurnStatus(status: ITurnRecord['status']): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
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
