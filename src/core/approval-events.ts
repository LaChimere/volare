import type { ApprovalDecision, ApprovalId, TurnId } from './types';

export interface IApprovalResolvedJournalEvent {
  type: 'permission.resolved';
  turnId: TurnId;
  approvalId: ApprovalId;
  decision: 'allow' | 'deny';
}

export function permissionResolvedJournalEvent(
  turnId: TurnId,
  approvalId: ApprovalId,
  decision: ApprovalDecision,
): IApprovalResolvedJournalEvent {
  return {
    type: 'permission.resolved',
    turnId,
    approvalId,
    decision: decision.type === 'allow' ? 'allow' : 'deny',
  };
}
