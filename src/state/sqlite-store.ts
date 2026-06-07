import type { Database } from 'bun:sqlite';

import { permissionResolvedJournalEvent } from '../core/approval-events';
import { VolareError } from '../core/errors';
import { createId } from '../core/ids';
import type {
  ApprovalDecision,
  ApprovalStatus,
  BackendSessionStatus,
  BridgeSessionId,
  ClientProtocol,
  IApprovalRecord,
  IApprovalResolutionInput,
  IApprovalResolutionResult,
  IBackendProcessMetadata,
  IBackendSession,
  IClientTurnRef,
  IIdleSessionPruneResult,
  IJournalEvent,
  IPermissionRequest,
  IStartupRecoveryResult,
  IStateStore,
  IThread,
  ITurnRecord,
  IWorkspace,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../core/types';

type WorkspaceRow = { id: string; root_path: string };
type ThreadRow = { id: string; workspace_id: string };
type TurnRow = {
  id: string;
  thread_id: string;
  parent_turn_id: string | null;
  bridge_session_id: string;
  status: ITurnRecord['status'];
  model: string;
  created_at: number;
  completed_at: number | null;
};
type ClientTurnRefRow = {
  protocol: string;
  external_id: string;
  turn_id: string;
  thread_id: string;
  parent_protocol: string | null;
  parent_external_id: string | null;
};
type BackendSessionRow = {
  id: string;
  workspace_id: string;
  thread_id: string;
  backend_session_id: string | null;
  status: BackendSessionStatus;
};
type ApprovalRow = {
  id: string;
  turn_id: string;
  bridge_session_id: string;
  status: ApprovalStatus;
  redacted_request_json: string;
  decision_json: string | null;
  timeout_at: number;
  created_at: number;
  decided_at: number | null;
};

const TERMINAL_TURN_STATUSES = new Set<ITurnRecord['status']>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export class SQLiteStateStore implements IStateStore {
  constructor(readonly database: Database) {
    this.database.run('PRAGMA foreign_keys = ON');
  }

  async getOrCreateWorkspace(input: { rootPath: string }): Promise<IWorkspace> {
    const existing = await this.getWorkspaceByPath(input.rootPath);
    if (existing) {
      return existing;
    }

    const id = createId('workspace');
    try {
      this.database
        .query('INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)')
        .run(id, input.rootPath, Date.now());
    } catch (cause) {
      const raced = await this.getWorkspaceByPath(input.rootPath);
      if (raced) {
        return raced;
      }
      throw new VolareError('workspace_create_failed', 'Workspace could not be created', {
        cause,
      });
    }

    return { id, rootPath: input.rootPath };
  }

  async getWorkspace(workspaceId: WorkspaceId): Promise<IWorkspace | null> {
    const row = this.database
      .query<WorkspaceRow, [string]>('SELECT id, root_path FROM workspaces WHERE id = ?')
      .get(workspaceId);
    return row ? workspaceFromRow(row) : null;
  }

  async getWorkspaceByPath(rootPath: string): Promise<IWorkspace | null> {
    const row = this.database
      .query<WorkspaceRow, [string]>('SELECT id, root_path FROM workspaces WHERE root_path = ?')
      .get(rootPath);
    return row ? workspaceFromRow(row) : null;
  }

  async createThread(input: { workspaceId: WorkspaceId }): Promise<IThread> {
    const id = createId('thread');
    const now = Date.now();
    this.database
      .query('INSERT INTO threads (id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, input.workspaceId, now, now);
    return { id, workspaceId: input.workspaceId };
  }

  async getThread(threadId: ThreadId): Promise<IThread | null> {
    const row = this.database
      .query<ThreadRow, [string]>('SELECT id, workspace_id FROM threads WHERE id = ?')
      .get(threadId);
    return row ? threadFromRow(row) : null;
  }

  async createTurn(input: {
    threadId: ThreadId;
    parentTurnId?: TurnId;
    bridgeSessionId: BridgeSessionId;
    model: string;
  }): Promise<ITurnRecord> {
    const id = createId('turn');
    const now = Date.now();
    this.database
      .query(
        `INSERT INTO turns
          (id, thread_id, parent_turn_id, bridge_session_id, status, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.parentTurnId ?? null,
        input.bridgeSessionId,
        'queued',
        input.model,
        now,
      );
    return {
      id,
      threadId: input.threadId,
      parentTurnId: input.parentTurnId ?? null,
      bridgeSessionId: input.bridgeSessionId,
      status: 'queued',
      model: input.model,
      createdAt: new Date(now),
    };
  }

  async getTurn(turnId: TurnId): Promise<ITurnRecord | null> {
    const row = this.database
      .query<TurnRow, [string]>(
        `SELECT id, thread_id, parent_turn_id, bridge_session_id, status, model, created_at, completed_at
         FROM turns WHERE id = ?`,
      )
      .get(turnId);
    return row ? turnFromRow(row) : null;
  }

  async updateTurnStatus(
    turnId: TurnId,
    fromStatus: ITurnRecord['status'] | 'any-non-terminal',
    toStatus: ITurnRecord['status'],
    completedAt?: number,
  ): Promise<boolean> {
    const current = await this.getTurn(turnId);
    if (!current) {
      return false;
    }
    if (fromStatus !== 'any-non-terminal' && current.status !== fromStatus) {
      return false;
    }
    if (fromStatus === 'any-non-terminal' && TERMINAL_TURN_STATUSES.has(current.status)) {
      return false;
    }

    const result = this.database
      .query('UPDATE turns SET status = ?, completed_at = ? WHERE id = ? AND status = ?')
      .run(toStatus, completedAt ?? null, turnId, current.status);
    return result.changes === 1;
  }

  async bindClientRef(ref: IClientTurnRef): Promise<void> {
    this.database
      .query(
        `INSERT INTO client_turn_refs
          (protocol, external_id, turn_id, thread_id, parent_protocol, parent_external_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ref.protocol,
        ref.externalId,
        ref.turnId,
        ref.threadId,
        ref.parentProtocol ?? null,
        ref.parentExternalId ?? null,
        Date.now(),
      );
  }

  async resolveClientRef(
    protocol: ClientProtocol,
    externalId: string,
  ): Promise<IClientTurnRef | null> {
    const row = this.database
      .query<ClientTurnRefRow, [string, string]>(
        `SELECT protocol, external_id, turn_id, thread_id, parent_protocol, parent_external_id
         FROM client_turn_refs WHERE protocol = ? AND external_id = ?`,
      )
      .get(protocol, externalId);
    return row ? clientTurnRefFromRow(row) : null;
  }

  async reserveBackendSession(input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    backend: string;
  }): Promise<IBackendSession> {
    const id = createId('bridge_session');
    const now = Date.now();
    this.database
      .query(
        `INSERT INTO backend_sessions
          (id, workspace_id, thread_id, backend, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.workspaceId, input.threadId, input.backend, 'initializing', now, now);
    return {
      bridgeSessionId: id,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      status: 'initializing',
    };
  }

  async activateBackendSession(
    session: IBackendSession,
    metadata: IBackendProcessMetadata,
  ): Promise<void> {
    const result = this.database
      .query(
        `UPDATE backend_sessions
         SET backend_session_id = ?, process_id = ?, process_started_at = ?, process_identity_hash = ?,
             status = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        metadata.backendSessionId,
        metadata.processId ?? null,
        metadata.processStartedAt ?? null,
        metadata.processIdentityHash ?? null,
        'active',
        Date.now(),
        session.bridgeSessionId,
        'initializing',
      );
    if (result.changes !== 1) {
      throw new VolareError(
        'backend_session_activation_failed',
        'Backend session could not be activated',
      );
    }
  }

  async updateBackendSessionStatus(
    bridgeSessionId: BridgeSessionId,
    fromStatus: BackendSessionStatus | 'any',
    toStatus: BackendSessionStatus,
  ): Promise<boolean> {
    const current = await this.getBackendSession(bridgeSessionId);
    if (!current) {
      return false;
    }
    if (fromStatus !== 'any' && current.status !== fromStatus) {
      return false;
    }
    const result = this.database
      .query('UPDATE backend_sessions SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(toStatus, Date.now(), bridgeSessionId, current.status);
    return result.changes === 1;
  }

  async getBackendSession(bridgeSessionId: BridgeSessionId): Promise<IBackendSession | null> {
    const row = this.database
      .query<BackendSessionRow, [string]>(
        'SELECT id, workspace_id, thread_id, backend_session_id, status FROM backend_sessions WHERE id = ?',
      )
      .get(bridgeSessionId);
    return row ? backendSessionFromRow(row) : null;
  }

  async getBackendSessionByThread(threadId: ThreadId): Promise<IBackendSession | null> {
    const row = this.database
      .query<BackendSessionRow, [string]>(
        `SELECT id, workspace_id, thread_id, backend_session_id, status
         FROM backend_sessions
         WHERE thread_id = ? AND status IN ('active', 'idle')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(threadId);
    return row ? backendSessionFromRow(row) : null;
  }

  async createApproval(input: {
    approvalId?: string;
    turnId: TurnId;
    bridgeSessionId: BridgeSessionId;
    request: IPermissionRequest;
    timeoutAt: number;
    journalEvent?: IJournalEvent;
  }): Promise<IApprovalRecord> {
    const id = input.approvalId ?? createId('approval');
    const now = Date.now();
    const insertApproval = () => {
      this.database
        .query(
          `INSERT INTO approvals
            (id, turn_id, bridge_session_id, status, redacted_request_json, timeout_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.turnId,
          input.bridgeSessionId,
          'pending',
          JSON.stringify(input.request),
          input.timeoutAt,
          now,
        );
      if (input.journalEvent) {
        insertJournalEvent(this.database, input.journalEvent, now);
      }
    };
    if (input.journalEvent) {
      this.database.transaction(insertApproval)();
    } else {
      insertApproval();
    }
    return {
      id,
      turnId: input.turnId,
      bridgeSessionId: input.bridgeSessionId,
      status: 'pending',
      request: input.request,
      timeoutAt: input.timeoutAt,
      createdAt: new Date(now),
    };
  }

  async getApproval(approvalId: string): Promise<IApprovalRecord | null> {
    const row = this.database
      .query<ApprovalRow, [string]>(
        `SELECT id, turn_id, bridge_session_id, status, redacted_request_json, decision_json,
                timeout_at, created_at, decided_at
         FROM approvals WHERE id = ?`,
      )
      .get(approvalId);
    return row ? approvalFromRow(row) : null;
  }

  async listPendingApprovals(): Promise<IApprovalRecord[]> {
    return this.database
      .query<ApprovalRow, []>(
        `SELECT id, turn_id, bridge_session_id, status, redacted_request_json, decision_json,
                timeout_at, created_at, decided_at
         FROM approvals WHERE status = 'pending'
         ORDER BY created_at ASC, id ASC`,
      )
      .all()
      .map(approvalFromRow);
  }

  async resolveApprovalWithJournal(
    input: IApprovalResolutionInput,
  ): Promise<IApprovalResolutionResult> {
    const transaction = this.database.transaction(() => {
      const approval = this.database
        .query<ApprovalRow, [string]>(
          `SELECT id, turn_id, bridge_session_id, status, redacted_request_json, decision_json,
                  timeout_at, created_at, decided_at
           FROM approvals WHERE id = ?`,
        )
        .get(input.approvalId);
      if (!approval) {
        throw new VolareError('approval_not_found', 'Approval was not found');
      }
      if (approval.status !== 'pending') {
        return {
          status: 'already_terminal' as const,
          decision: parseJson<ApprovalDecision>(approval.decision_json),
        };
      }

      const now = Date.now();
      this.database
        .query('UPDATE approvals SET status = ?, decision_json = ?, decided_at = ? WHERE id = ?')
        .run(
          approvalStatusForDecision(input.decision),
          JSON.stringify(input.decision),
          now,
          approval.id,
        );
      insertJournalEvent(this.database, input.journalEvent, now);
      return { status: 'resolved' as const, decision: input.decision };
    });
    return transaction();
  }

  async recoverStartupState(
    input: { now?: number; approvalAbortReason?: string } = {},
  ): Promise<IStartupRecoveryResult> {
    const now = input.now ?? Date.now();
    const approvalAbortReason = input.approvalAbortReason ?? 'startup_recovery';
    const transaction = this.database.transaction(() => {
      const interruptedTurns = this.database
        .query(
          `UPDATE turns
           SET status = 'interrupted', completed_at = ?
           WHERE status IN ('queued', 'running', 'cancelling')`,
        )
        .run(now);
      const abandonedSessions = this.database
        .query(
          `UPDATE backend_sessions
           SET status = 'abandoned', updated_at = ?
           WHERE status IN ('initializing', 'active', 'idle', 'disposing', 'stale')`,
        )
        .run(now);
      const abortedApprovalCount = abortPendingApprovalsForRecovery(
        this.database,
        now,
        approvalAbortReason,
      );
      return {
        interruptedTurnCount: interruptedTurns.changes,
        abandonedSessionCount: abandonedSessions.changes,
        abortedApprovalCount,
      };
    });
    return transaction();
  }

  async pruneIdleBackendSessions(input: {
    updatedBefore: number;
    now?: number;
  }): Promise<IIdleSessionPruneResult> {
    const result = this.database
      .query(
        `UPDATE backend_sessions
         SET status = 'disposed', updated_at = ?
         WHERE status = 'idle'
           AND updated_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM turns
             WHERE turns.bridge_session_id = backend_sessions.id
               AND turns.status IN ('queued', 'running', 'cancelling')
           )`,
      )
      .run(input.now ?? Date.now(), input.updatedBefore);
    return { prunedSessionCount: result.changes };
  }
}

function workspaceFromRow(row: WorkspaceRow): IWorkspace {
  return { id: row.id, rootPath: row.root_path };
}

function threadFromRow(row: ThreadRow): IThread {
  return { id: row.id, workspaceId: row.workspace_id };
}

function turnFromRow(row: TurnRow): ITurnRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    parentTurnId: row.parent_turn_id,
    bridgeSessionId: row.bridge_session_id,
    status: row.status,
    model: row.model,
    createdAt: new Date(row.created_at),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at) } : {}),
  };
}

function clientTurnRefFromRow(row: ClientTurnRefRow): IClientTurnRef {
  return {
    protocol: row.protocol,
    externalId: row.external_id,
    turnId: row.turn_id,
    threadId: row.thread_id,
    ...(row.parent_protocol ? { parentProtocol: row.parent_protocol } : {}),
    ...(row.parent_external_id ? { parentExternalId: row.parent_external_id } : {}),
  };
}

function backendSessionFromRow(row: BackendSessionRow): IBackendSession {
  return {
    bridgeSessionId: row.id,
    ...(row.backend_session_id ? { backendSessionId: row.backend_session_id } : {}),
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    status: row.status,
  };
}

function approvalFromRow(row: ApprovalRow): IApprovalRecord {
  return {
    id: row.id,
    turnId: row.turn_id,
    bridgeSessionId: row.bridge_session_id,
    status: row.status,
    request: parseJson<IPermissionRequest>(row.redacted_request_json),
    ...(row.decision_json ? { decision: parseJson<ApprovalDecision>(row.decision_json) } : {}),
    timeoutAt: row.timeout_at,
    createdAt: new Date(row.created_at),
    ...(row.decided_at ? { decidedAt: new Date(row.decided_at) } : {}),
  };
}

function approvalStatusForDecision(decision: ApprovalDecision): ApprovalStatus {
  switch (decision.type) {
    case 'allow':
      return 'allowed';
    case 'deny':
      return 'denied';
    case 'timeout':
      return 'timed_out';
    case 'aborted':
      return 'aborted';
  }
}

function abortPendingApprovalsForRecovery(database: Database, now: number, reason: string): number {
  const pendingApprovals = database
    .query<ApprovalRow, []>(
      `SELECT id, turn_id, bridge_session_id, status, redacted_request_json, decision_json,
              timeout_at, created_at, decided_at
       FROM approvals WHERE status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    )
    .all();
  let abortedApprovalCount = 0;
  const decision = { type: 'aborted', reason } satisfies ApprovalDecision;
  for (const approval of pendingApprovals) {
    const result = database
      .query(
        `UPDATE approvals
         SET status = 'aborted', decision_json = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(decision), now, approval.id);
    if (result.changes !== 1) {
      continue;
    }
    abortedApprovalCount += 1;
    insertJournalEvent(
      database,
      {
        turnId: approval.turn_id,
        kind: 'canonical',
        canonicalJson: permissionResolvedJournalEvent(approval.turn_id, approval.id, decision),
      },
      now,
    );
  }
  return abortedApprovalCount;
}

function parseJson<T>(value: string | null): T {
  if (!value) {
    throw new VolareError('state_decode_failed', 'Persisted JSON value is missing');
  }
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new VolareError('state_decode_failed', 'Persisted JSON value is malformed', {
      cause,
    });
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function insertJournalEvent(database: Database, event: IJournalEvent, now: number): void {
  const seq = nextEventSeq(database, event.turnId);
  database
    .query(
      `INSERT INTO events
        (id, turn_id, seq, kind, redacted_raw_json, canonical_json, encoded_json, redaction_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id ?? createId('event'),
      event.turnId,
      event.seq ?? seq,
      event.kind,
      jsonOrNull(event.redactedRawJson),
      jsonOrNull(event.canonicalJson),
      jsonOrNull(event.encodedJson),
      jsonOrNull(event.redactionJson),
      event.createdAt ?? now,
    );
}

function nextEventSeq(database: Database, turnId: TurnId): number {
  const row = database
    .query<{ next_seq: number }, [string]>(
      'SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM events WHERE turn_id = ?',
    )
    .get(turnId);
  return row?.next_seq ?? 0;
}
