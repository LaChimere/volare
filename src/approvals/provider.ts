import { permissionResolvedJournalEvent } from '../core/approval-events';
import { VolareError } from '../core/errors';
import type {
  ApprovalDecision,
  ApprovalEvaluation,
  IApprovalAbortPendingInput,
  IApprovalAbortPendingResult,
  IApprovalContext,
  IApprovalPolicy,
  IApprovalProvider,
  IApprovalRecord,
  IApprovalResolutionRequest,
  IApprovalResolutionResult,
  IPermissionRequest,
  IStateStore,
} from '../core/types';
import { type ILogger, NoopLogger } from '../logging/logger';
import { DefaultApprovalPolicy } from './policy';

export interface IApprovalProviderOptions {
  store: IStateStore;
  policy?: IApprovalPolicy;
  now?: () => number;
  pollMs?: number;
  logger?: ILogger;
}

export class ApprovalProvider implements IApprovalProvider {
  readonly #store: IStateStore;
  readonly #policy: IApprovalPolicy;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #logger: ILogger;
  #drainingReason: string | null = null;
  #activeEvaluations = 0;
  readonly #evaluationDrainWaiters = new Set<() => void>();

  constructor(options: IApprovalProviderOptions) {
    this.#store = options.store;
    this.#policy = options.policy ?? new DefaultApprovalPolicy();
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? 50;
    this.#logger = (options.logger ?? new NoopLogger()).child({ component: 'approval-provider' });
  }

  async evaluate(
    request: IPermissionRequest,
    context: IApprovalContext,
  ): Promise<ApprovalEvaluation> {
    this.#beginEvaluation();
    try {
      const evaluation = await this.#policy.evaluate(request, context);
      this.#assertNotDraining();
      if (evaluation.type !== 'ask') {
        this.#logger.info(
          {
            event: 'approval.policy.evaluated',
            turnId: context.turnId,
            threadId: context.threadId,
            workspaceId: context.workspaceId,
            action: request.action,
            evaluation: evaluation.type,
          },
          'approval policy evaluated',
        );
        return evaluation;
      }

      const approvalId = context.approvalId ?? evaluation.approvalId;
      const approval = await this.#store.createApproval({
        approvalId,
        turnId: context.turnId,
        bridgeSessionId: context.bridgeSessionId,
        request: evaluation.request,
        timeoutAt: evaluation.timeoutAt,
        journalEvent: {
          turnId: context.turnId,
          kind: 'canonical',
          canonicalJson: permissionRequiredEvent(context.turnId, approvalId, evaluation.request),
        },
      });
      this.#logger.info(
        {
          event: 'approval.policy.evaluated',
          turnId: context.turnId,
          threadId: context.threadId,
          workspaceId: context.workspaceId,
          bridgeSessionId: context.bridgeSessionId,
          approvalId: approval.id,
          action: request.action,
          evaluation: 'ask',
          timeoutAt: approval.timeoutAt,
        },
        'approval policy evaluated',
      );
      return {
        type: 'ask',
        approvalId: approval.id,
        timeoutAt: approval.timeoutAt,
        request: approval.request,
      };
    } finally {
      this.#endEvaluation();
    }
  }

  async resolveApproval(input: IApprovalResolutionRequest): Promise<IApprovalResolutionResult> {
    const approval = await this.#requireApproval(input.approvalId);
    await this.#assertApprovalOwnership(approval, input);
    const result = await this.#resolveApprovalRecord(approval, input.decision);
    this.#logger.info(
      {
        event: 'approval.resolved',
        approvalId: input.approvalId,
        turnId: approval.turnId,
        bridgeSessionId: approval.bridgeSessionId,
        status: result.status,
        decision: result.decision.type,
      },
      'approval resolved',
    );
    return result;
  }

  async abortPendingApprovals(
    input: IApprovalAbortPendingInput,
  ): Promise<IApprovalAbortPendingResult> {
    this.#drainingReason = input.reason;
    await this.#waitForEvaluationsToDrain();
    const pendingApprovals = await this.#store.listPendingApprovals();
    let abortedApprovalCount = 0;
    for (const approval of pendingApprovals) {
      const result = await this.#resolveApprovalRecord(approval, {
        type: 'aborted',
        reason: input.reason,
      });
      if (result.status === 'resolved') {
        abortedApprovalCount += 1;
      }
    }
    if (abortedApprovalCount > 0) {
      this.#logger.warn(
        { event: 'approval.pending_aborted', abortedApprovalCount, reason: input.reason },
        'pending approvals aborted',
      );
    }
    return { abortedApprovalCount };
  }

  async awaitDecision(approvalId: string, signal?: AbortSignal): Promise<ApprovalDecision> {
    while (true) {
      const approval = await this.#requireApproval(approvalId);
      if (approval.decision) {
        this.#logger.info(
          {
            event: 'approval.await.completed',
            approvalId,
            turnId: approval.turnId,
            status: approval.status,
            decision: approval.decision.type,
          },
          'approval await completed',
        );
        return approval.decision;
      }
      if (signal?.aborted) {
        this.#logger.warn(
          { event: 'approval.await.aborted', approvalId, turnId: approval.turnId },
          'approval await aborted',
        );
        return (
          await this.#resolveApprovalRecord(approval, {
            type: 'aborted',
            reason: 'turn_cancelled',
          })
        ).decision;
      }
      if (this.#now() >= approval.timeoutAt) {
        this.#logger.warn(
          { event: 'approval.await.timed_out', approvalId, turnId: approval.turnId },
          'approval await timed out',
        );
        return (
          await this.#resolveApprovalRecord(approval, {
            type: 'timeout',
            reason: 'approval_timeout',
          })
        ).decision;
      }
      await sleep(this.#pollMs, signal);
    }
  }

  async #resolveApprovalRecord(
    approval: IApprovalRecord,
    decision: ApprovalDecision,
  ): Promise<IApprovalResolutionResult> {
    return await this.#store.resolveApprovalWithJournal({
      approvalId: approval.id,
      decision,
      journalEvent: {
        turnId: approval.turnId,
        kind: 'canonical',
        canonicalJson: permissionResolvedJournalEvent(approval.turnId, approval.id, decision),
      },
    });
  }

  async #assertApprovalOwnership(approval: IApprovalRecord, input: IApprovalResolutionRequest) {
    const turn = await this.#store.getTurn(input.turnId);
    const session = await this.#store.getBackendSession(input.bridgeSessionId);
    if (
      approval.turnId !== input.turnId ||
      approval.bridgeSessionId !== input.bridgeSessionId ||
      !turn ||
      !session ||
      turn.bridgeSessionId !== input.bridgeSessionId ||
      session.threadId !== turn.threadId
    ) {
      throw new VolareError(
        'approval_scope_mismatch',
        'Approval ownership does not match the request',
      );
    }
  }

  #assertNotDraining(): void {
    if (this.#drainingReason) {
      throw new VolareError('service_unavailable', 'Approval provider is draining during shutdown');
    }
  }

  #beginEvaluation(): void {
    this.#assertNotDraining();
    this.#activeEvaluations += 1;
  }

  #endEvaluation(): void {
    this.#activeEvaluations = Math.max(0, this.#activeEvaluations - 1);
    if (this.#activeEvaluations === 0) {
      for (const resolve of this.#evaluationDrainWaiters) {
        resolve();
      }
      this.#evaluationDrainWaiters.clear();
    }
  }

  async #waitForEvaluationsToDrain(): Promise<void> {
    if (this.#activeEvaluations === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#evaluationDrainWaiters.add(resolve);
    });
  }

  async #requireApproval(approvalId: string) {
    const approval = await this.#store.getApproval(approvalId);
    if (!approval) {
      throw new VolareError('approval_not_found', 'Approval was not found');
    }
    return approval;
  }
}

function permissionRequiredEvent(turnId: string, approvalId: string, request: IPermissionRequest) {
  return {
    type: 'permission.required',
    turnId,
    approvalId,
    action: request.action,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
