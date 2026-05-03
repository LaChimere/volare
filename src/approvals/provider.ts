import { AgentLoomError } from '../core/errors';
import type {
  ApprovalContextInterface,
  ApprovalDecision,
  ApprovalEvaluation,
  ApprovalPolicyInterface,
  ApprovalProviderInterface,
  ApprovalResolutionResultInterface,
  PermissionRequestInterface,
  StateStoreInterface,
} from '../core/types';
import { type LoggerInterface, NoopLogger } from '../logging/logger';
import { DefaultApprovalPolicy } from './policy';

export interface ApprovalProviderOptionsInterface {
  store: StateStoreInterface;
  policy?: ApprovalPolicyInterface;
  now?: () => number;
  pollMs?: number;
  logger?: LoggerInterface;
}

export class ApprovalProvider implements ApprovalProviderInterface {
  readonly #store: StateStoreInterface;
  readonly #policy: ApprovalPolicyInterface;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #logger: LoggerInterface;

  constructor(options: ApprovalProviderOptionsInterface) {
    this.#store = options.store;
    this.#policy = options.policy ?? new DefaultApprovalPolicy();
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? 50;
    this.#logger = (options.logger ?? new NoopLogger()).child({ component: 'approval-provider' });
  }

  async evaluate(
    request: PermissionRequestInterface,
    context: ApprovalContextInterface,
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
  ): Promise<ApprovalResolutionResultInterface> {
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
      throw new AgentLoomError('approval_not_found', 'Approval was not found');
    }
    return approval;
  }
}

function permissionRequiredEvent(
  turnId: string,
  approvalId: string,
  request: PermissionRequestInterface,
) {
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
