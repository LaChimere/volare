import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CURRENT_SCHEMA_VERSION, migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

function openStore(databasePath: string): { database: Database; store: SQLiteStateStore } {
  const database = new Database(databasePath);
  migrate(database);
  return { database, store: new SQLiteStateStore(database) };
}

describe('SQLiteStateStore durability', () => {
  test('reopens file-backed state with schema and persisted session records intact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'volare-durable-state-'));
    const databasePath = path.join(root, 'state.sqlite');
    try {
      const first = openStore(databasePath);
      const workspace = await first.store.getOrCreateWorkspace({ rootPath: '/tmp/volare' });
      const thread = await first.store.createThread({ workspaceId: workspace.id });
      const session = await first.store.reserveBackendSession({
        workspaceId: workspace.id,
        threadId: thread.id,
        backend: 'mock',
      });
      await first.store.activateBackendSession(session, { backendSessionId: 'backend_1' });
      const turn = await first.store.createTurn({
        threadId: thread.id,
        bridgeSessionId: session.bridgeSessionId,
        model: 'copilot-agent',
      });
      await first.store.bindClientRef({
        protocol: 'openai-responses-v1',
        externalId: 'resp_1',
        turnId: turn.id,
        threadId: thread.id,
      });
      first.database.close();

      const reopened = openStore(databasePath);
      migrate(reopened.database);

      expect(
        reopened.database
          .query<{ version: number }, []>('SELECT version FROM schema_version')
          .get(),
      ).toEqual({ version: CURRENT_SCHEMA_VERSION });
      expect(
        reopened.database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get(),
      ).toEqual({ integrity_check: 'ok' });
      await expect(reopened.store.getWorkspace(workspace.id)).resolves.toEqual(workspace);
      await expect(reopened.store.getThread(thread.id)).resolves.toEqual(thread);
      await expect(reopened.store.getTurn(turn.id)).resolves.toMatchObject({
        id: turn.id,
        status: 'queued',
      });
      await expect(
        reopened.store.getBackendSession(session.bridgeSessionId),
      ).resolves.toMatchObject({
        bridgeSessionId: session.bridgeSessionId,
        backendSessionId: 'backend_1',
        status: 'active',
      });
      await expect(
        reopened.store.resolveClientRef('openai-responses-v1', 'resp_1'),
      ).resolves.toMatchObject({
        externalId: 'resp_1',
        turnId: turn.id,
        threadId: thread.id,
      });
      reopened.database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers non-terminal file-backed state after reopen', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'volare-durable-recovery-'));
    const databasePath = path.join(root, 'state.sqlite');
    try {
      const first = openStore(databasePath);
      const workspace = await first.store.getOrCreateWorkspace({ rootPath: '/tmp/volare' });
      const thread = await first.store.createThread({ workspaceId: workspace.id });
      const session = await first.store.reserveBackendSession({
        workspaceId: workspace.id,
        threadId: thread.id,
        backend: 'mock',
      });
      await first.store.activateBackendSession(session, { backendSessionId: 'backend_1' });
      const turn = await first.store.createTurn({
        threadId: thread.id,
        bridgeSessionId: session.bridgeSessionId,
        model: 'copilot-agent',
      });
      await first.store.updateTurnStatus(turn.id, 'queued', 'running');
      const approval = await first.store.createApproval({
        turnId: turn.id,
        bridgeSessionId: session.bridgeSessionId,
        request: { action: 'shell:exec', scope: { command: 'bun test' } },
        timeoutAt: 999,
      });
      first.database.close();

      const reopened = openStore(databasePath);
      await expect(reopened.store.recoverStartupState({ now: 444 })).resolves.toEqual({
        interruptedTurnCount: 1,
        abandonedSessionCount: 1,
        abortedApprovalCount: 1,
      });
      await expect(reopened.store.getTurn(turn.id)).resolves.toMatchObject({
        status: 'interrupted',
        completedAt: new Date(444),
      });
      await expect(
        reopened.store.getBackendSession(session.bridgeSessionId),
      ).resolves.toMatchObject({
        status: 'abandoned',
      });
      await expect(reopened.store.getApproval(approval.id)).resolves.toMatchObject({
        status: 'aborted',
        decision: { type: 'aborted', reason: 'startup_recovery' },
      });
      expect(
        reopened.database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get(),
      ).toEqual({ integrity_check: 'ok' });
      reopened.database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
