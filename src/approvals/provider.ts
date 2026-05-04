import { VolareError } from '../core/errors';
import type {
  ApprovalDecision,
  ApprovalEvaluation,
  IApprovalContext,
  IApprovalPolicy,
  IApprovalProvider,
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
    const evaluation = await this.#policy.evaluate(request, context);
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
  }

  async resolve(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<IApprovalResolutionResult> {
    const approval = await this.#requireApproval(approvalId);
    const result = await this.#store.resolveApprovalWithJournal({
      approvalId,
      decision,
      journalEvent: {
        turnId: approval.turnId,
        kind: 'canonical',
        canonicalJson: permissionResolvedEvent(approval.turnId, approval.id, decision),
      },
    });
    this.#logger.info(
      {
        event: 'approval.resolved',
        approvalId,
        turnId: approval.turnId,
        bridgeSessionId: approval.bridgeSessionId,
        status: result.status,
        decision: result.decision.type,
      },
      'approval resolved',
    );
    return result;
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
        return (await this.resolve(approvalId, { type: 'aborted', reason: 'turn_cancelled' }))
          .decision;
      }
      if (this.#now() >= approval.timeoutAt) {
        this.#logger.warn(
          { event: 'approval.await.timed_out', approvalId, turnId: approval.turnId },
          'approval await timed out',
        );
        return (await this.resolve(approvalId, { type: 'timeout', reason: 'approval_timeout' }))
          .decision;
      }
      await sleep(this.#pollMs, signal);
    }
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

function permissionResolvedEvent(turnId: string, approvalId: string, decision: ApprovalDecision) {
  return {
    type: 'permission.resolved',
    turnId,
    approvalId,
    decision: decision.type === 'allow' ? 'allow' : 'deny',
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
