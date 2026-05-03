import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { CURRENT_SCHEMA_VERSION, migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

function createStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new SQLiteStateStore(database);
}

describe('SQLiteStateStore migrations', () => {
  test('creates the schema idempotently with version tracking and foreign keys', () => {
    const database = new Database(':memory:');

    migrate(database);
    migrate(database);

    const schemaVersion = database
      .query<{ version: number }, []>('SELECT version FROM schema_version')
      .all();
    const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();

    expect(schemaVersion).toEqual([{ version: CURRENT_SCHEMA_VERSION }]);
    expect(foreignKeys).toEqual({ foreign_keys: 1 });
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual([
      'approvals',
      'backend_sessions',
      'client_turn_refs',
      'events',
      'schema_version',
      'threads',
      'turns',
      'workspaces',
    ]);
  });
});

describe('SQLiteStateStore', () => {
  test('gets or creates workspaces atomically by root path', async () => {
    const store = createStore();

    const first = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });
    const second = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });

    expect(second).toEqual(first);
  });

  test('creates queued turns and compare-and-set status updates', async () => {
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });
    const thread = await store.createThread({ workspaceId: workspace.id });
    const session = await store.reserveBackendSession({
      workspaceId: workspace.id,
      threadId: thread.id,
      backend: 'mock',
    });

    const turn = await store.createTurn({
      threadId: thread.id,
      bridgeSessionId: session.bridgeSessionId,
      model: 'copilot-agent',
    });

    expect(turn.status).toBe('queued');
    expect(await store.updateTurnStatus(turn.id, 'queued', 'running')).toBe(true);
    expect(await store.updateTurnStatus(turn.id, 'queued', 'succeeded')).toBe(false);
    expect(await store.updateTurnStatus(turn.id, 'any-non-terminal', 'succeeded', 123)).toBe(true);
    expect(await store.updateTurnStatus(turn.id, 'any-non-terminal', 'running')).toBe(false);
  });

  test('reserves, activates, and updates backend sessions', async () => {
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });
    const thread = await store.createThread({ workspaceId: workspace.id });
    const session = await store.reserveBackendSession({
      workspaceId: workspace.id,
      threadId: thread.id,
      backend: 'mock',
    });

    expect(session.status).toBe('initializing');
    await store.activateBackendSession(session, { backendSessionId: 'backend_1' });
    expect(await store.getBackendSession(session.bridgeSessionId)).toMatchObject({
      bridgeSessionId: session.bridgeSessionId,
      backendSessionId: 'backend_1',
      status: 'active',
    });
    expect(await store.updateBackendSessionStatus(session.bridgeSessionId, 'active', 'idle')).toBe(
      true,
    );
    expect(await store.getBackendSessionByThread(thread.id)).toMatchObject({
      bridgeSessionId: session.bridgeSessionId,
      status: 'idle',
    });
    await expect(
      store.activateBackendSession(session, { backendSessionId: 'backend_2' }),
    ).rejects.toThrow('Backend session could not be activated');
  });

  test('binds and resolves client refs', async () => {
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });
    const thread = await store.createThread({ workspaceId: workspace.id });
    const session = await store.reserveBackendSession({
      workspaceId: workspace.id,
      threadId: thread.id,
      backend: 'mock',
    });
    const turn = await store.createTurn({
      threadId: thread.id,
      bridgeSessionId: session.bridgeSessionId,
      model: 'copilot-agent',
    });

    await store.bindClientRef({
      protocol: 'openai-responses-v1',
      externalId: 'resp_1',
      turnId: turn.id,
      threadId: thread.id,
    });

    expect(await store.resolveClientRef('openai-responses-v1', 'resp_1')).toMatchObject({
      externalId: 'resp_1',
      turnId: turn.id,
      threadId: thread.id,
    });
  });

  test('creates approvals and resolves them atomically with a journal event', async () => {
    const store = createStore();
    const { session, turn } = await createTurnFixture(store);
    const approval = await store.createApproval({
      turnId: turn.id,
      bridgeSessionId: session.bridgeSessionId,
      request: { action: 'shell:exec', scope: { command: 'bun test' } },
      timeoutAt: 1234,
    });

    expect(approval.status).toBe('pending');
    const result = await store.resolveApprovalWithJournal({
      approvalId: approval.id,
      decision: { type: 'deny', scope: 'once', reason: 'test' },
      journalEvent: {
        turnId: turn.id,
        kind: 'canonical',
        canonicalJson: {
          type: 'permission.resolved',
          turnId: turn.id,
          approvalId: approval.id,
          decision: 'deny',
        },
      },
    });

    expect(result).toEqual({
      status: 'resolved',
      decision: { type: 'deny', scope: 'once', reason: 'test' },
    });
    await expect(store.getApproval(approval.id)).resolves.toMatchObject({
      status: 'denied',
      decision: { type: 'deny', scope: 'once', reason: 'test' },
    });
    expect(
      store.database
        .query<{ seq: number; canonical_json: string }, [string]>(
          'SELECT seq, canonical_json FROM events WHERE turn_id = ?',
        )
        .all(turn.id),
    ).toEqual([
      {
        seq: 0,
        canonical_json: JSON.stringify({
          type: 'permission.resolved',
          turnId: turn.id,
          approvalId: approval.id,
          decision: 'deny',
        }),
      },
    ]);
    await expect(
      store.resolveApprovalWithJournal({
        approvalId: approval.id,
        decision: { type: 'allow', scope: 'once' },
        journalEvent: { turnId: turn.id, kind: 'canonical', canonicalJson: {} },
      }),
    ).resolves.toEqual({
      status: 'already_terminal',
      decision: { type: 'deny', scope: 'once', reason: 'test' },
    });
  });

  test('fails approval JSON corruption with a typed state error', async () => {
    const store = createStore();
    const { session, turn } = await createTurnFixture(store);
    const approval = await store.createApproval({
      turnId: turn.id,
      bridgeSessionId: session.bridgeSessionId,
      request: { action: 'shell:exec', scope: { command: 'bun test' } },
      timeoutAt: 1234,
    });
    store.database
      .query('UPDATE approvals SET redacted_request_json = ? WHERE id = ?')
      .run('{bad json', approval.id);

    await expect(store.getApproval(approval.id)).rejects.toMatchObject({
      code: 'state_decode_failed',
    });
  });

  test('rolls back approval resolution when journal insertion fails', async () => {
    const store = createStore();
    const { session, turn } = await createTurnFixture(store);
    const approval = await store.createApproval({
      turnId: turn.id,
      bridgeSessionId: session.bridgeSessionId,
      request: { action: 'shell:exec', scope: { command: 'bun test' } },
      timeoutAt: 1234,
    });

    await expect(
      store.resolveApprovalWithJournal({
        approvalId: approval.id,
        decision: { type: 'allow', scope: 'once' },
        journalEvent: {
          turnId: 'turn_missing',
          kind: 'canonical',
          canonicalJson: { type: 'permission.resolved' },
        },
      }),
    ).rejects.toThrow();

    await expect(store.getApproval(approval.id)).resolves.toMatchObject({
      status: 'pending',
    });
    expect(
      store.database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM events').get(),
    ).toEqual({ count: 0 });
  });

  test('recovers startup state before serving requests', async () => {
    const store = createStore();
    const { session, turn } = await createTurnFixture(store);
    await store.updateTurnStatus(turn.id, 'queued', 'running');
    const terminalTurn = await store.createTurn({
      threadId: turn.threadId,
      bridgeSessionId: session.bridgeSessionId,
      model: 'copilot-agent',
    });
    await store.updateTurnStatus(terminalTurn.id, 'queued', 'succeeded', 111);
    const staleSession = await store.reserveBackendSession({
      workspaceId: session.workspaceId,
      threadId: turn.threadId,
      backend: 'mock',
    });
    await store.updateBackendSessionStatus(staleSession.bridgeSessionId, 'initializing', 'stale');

    await expect(store.recoverStartupState({ now: 222 })).resolves.toEqual({
      interruptedTurnCount: 1,
      abandonedSessionCount: 2,
    });

    await expect(store.getTurn(turn.id)).resolves.toMatchObject({
      status: 'interrupted',
      completedAt: new Date(222),
    });
    await expect(store.getTurn(terminalTurn.id)).resolves.toMatchObject({
      status: 'succeeded',
      completedAt: new Date(111),
    });
    await expect(store.getBackendSession(session.bridgeSessionId)).resolves.toMatchObject({
      status: 'abandoned',
    });
    await expect(store.getBackendSession(staleSession.bridgeSessionId)).resolves.toMatchObject({
      status: 'abandoned',
    });
    await expect(store.recoverStartupState({ now: 333 })).resolves.toEqual({
      interruptedTurnCount: 0,
      abandonedSessionCount: 0,
    });
  });

  test('prunes only idle backend sessions without non-terminal turns', async () => {
    const store = createStore();
    const { session, turn } = await createTurnFixture(store);
    await store.updateTurnStatus(turn.id, 'queued', 'succeeded', 100);
    await store.updateBackendSessionStatus(session.bridgeSessionId, 'active', 'idle');
    const activeFixture = await createTurnFixture(store);
    await store.updateBackendSessionStatus(activeFixture.session.bridgeSessionId, 'active', 'idle');
    store.database
      .query('UPDATE backend_sessions SET updated_at = ? WHERE id IN (?, ?)')
      .run(100, session.bridgeSessionId, activeFixture.session.bridgeSessionId);

    await expect(store.pruneIdleBackendSessions({ updatedBefore: 101, now: 200 })).resolves.toEqual(
      {
        prunedSessionCount: 1,
      },
    );

    await expect(store.getBackendSession(session.bridgeSessionId)).resolves.toMatchObject({
      status: 'disposed',
    });
    await expect(
      store.getBackendSession(activeFixture.session.bridgeSessionId),
    ).resolves.toMatchObject({
      status: 'idle',
    });
    await expect(store.getTurn(activeFixture.turn.id)).resolves.toMatchObject({
      status: 'queued',
    });
  });
});

async function createTurnFixture(store: SQLiteStateStore) {
  const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });
  const thread = await store.createThread({ workspaceId: workspace.id });
  const session = await store.reserveBackendSession({
    workspaceId: workspace.id,
    threadId: thread.id,
    backend: 'mock',
  });
  await store.activateBackendSession(session, { backendSessionId: 'backend_1' });
  const turn = await store.createTurn({
    threadId: thread.id,
    bridgeSessionId: session.bridgeSessionId,
    model: 'copilot-agent',
  });
  return { workspace, thread, session, turn };
}
