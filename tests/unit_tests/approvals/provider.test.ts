import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { DefaultApprovalPolicy } from '../../../src/approvals/policy';
import { ApprovalProvider } from '../../../src/approvals/provider';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

function createStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new SQLiteStateStore(database);
}

async function createFixture(store: SQLiteStateStore) {
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

describe('ApprovalProvider', () => {
  test('persists ask evaluations and resolves with a canonical journal event', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    const provider = new ApprovalProvider({
      store,
      policy: new DefaultApprovalPolicy({ now: () => 1000, timeoutMs: 5000 }),
    });

    const evaluation = await provider.evaluate(
      { action: 'shell:exec', scope: { command: 'bun test' } },
      {
        turnId: turn.id,
        threadId: thread.id,
        workspaceId: workspace.id,
        workspaceRootPath: workspace.rootPath,
        bridgeSessionId: session.bridgeSessionId,
      },
    );

    expect(evaluation).toMatchObject({ type: 'ask', timeoutAt: 6000 });
    if (evaluation.type !== 'ask') {
      throw new Error('expected ask');
    }
    await expect(store.getApproval(evaluation.approvalId)).resolves.toMatchObject({
      status: 'pending',
      turnId: turn.id,
      bridgeSessionId: session.bridgeSessionId,
    });

    await expect(
      provider.resolve(evaluation.approvalId, { type: 'deny', scope: 'once', reason: 'manual' }),
    ).resolves.toEqual({
      status: 'resolved',
      decision: { type: 'deny', scope: 'once', reason: 'manual' },
    });
    expect(canonicalEvents(store, turn.id)).toEqual([
      {
        type: 'permission.required',
        turnId: turn.id,
        approvalId: evaluation.approvalId,
        action: 'shell:exec',
      },
      {
        type: 'permission.resolved',
        turnId: turn.id,
        approvalId: evaluation.approvalId,
        decision: 'deny',
      },
    ]);
  });

  test('journals manual allow decisions', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    const provider = new ApprovalProvider({
      store,
      policy: new DefaultApprovalPolicy({ now: () => 1000, timeoutMs: 5000 }),
    });
    const evaluation = await provider.evaluate(
      { action: 'shell:exec', scope: { command: 'bun test' } },
      {
        turnId: turn.id,
        threadId: thread.id,
        workspaceId: workspace.id,
        workspaceRootPath: workspace.rootPath,
        bridgeSessionId: session.bridgeSessionId,
      },
    );
    if (evaluation.type !== 'ask') {
      throw new Error('expected ask');
    }

    await expect(
      provider.resolve(evaluation.approvalId, { type: 'allow', scope: 'once' }),
    ).resolves.toMatchObject({
      status: 'resolved',
      decision: { type: 'allow', scope: 'once' },
    });
    expect(canonicalEvents(store, turn.id)).toEqual([
      {
        type: 'permission.required',
        turnId: turn.id,
        approvalId: evaluation.approvalId,
        action: 'shell:exec',
      },
      {
        type: 'permission.resolved',
        turnId: turn.id,
        approvalId: evaluation.approvalId,
        decision: 'allow',
      },
    ]);
  });

  test('atomically resolves aborted awaits and makes later resolves idempotent', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    const provider = new ApprovalProvider({
      store,
      policy: new DefaultApprovalPolicy({ now: () => 1000, timeoutMs: 5000 }),
      pollMs: 1,
    });
    const evaluation = await provider.evaluate(
      { action: 'shell:exec', scope: { command: 'bun test' } },
      {
        turnId: turn.id,
        threadId: thread.id,
        workspaceId: workspace.id,
        workspaceRootPath: workspace.rootPath,
        bridgeSessionId: session.bridgeSessionId,
      },
    );
    if (evaluation.type !== 'ask') {
      throw new Error('expected ask');
    }
    const controller = new AbortController();
    controller.abort();

    await expect(provider.awaitDecision(evaluation.approvalId, controller.signal)).resolves.toEqual(
      {
        type: 'aborted',
        reason: 'turn_cancelled',
      },
    );
    await expect(store.getApproval(evaluation.approvalId)).resolves.toMatchObject({
      status: 'aborted',
      decision: { type: 'aborted', reason: 'turn_cancelled' },
    });
    await expect(
      provider.resolve(evaluation.approvalId, { type: 'allow', scope: 'once' }),
    ).resolves.toEqual({
      status: 'already_terminal',
      decision: { type: 'aborted', reason: 'turn_cancelled' },
    });
    expect(canonicalEvents(store, turn.id)).toEqual([
      {
        type: 'permission.required',
        turnId: turn.id,
        approvalId: evaluation.approvalId,
        action: 'shell:exec',
      },
      {
        type: 'permission.resolved',
        turnId: turn.id,
        approvalId: evaluation.approvalId,
        decision: 'deny',
      },
    ]);
  });

  test('atomically resolves timed-out awaits before returning', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    const provider = new ApprovalProvider({
      store,
      policy: new DefaultApprovalPolicy({ now: () => 1000, timeoutMs: 1 }),
      now: () => 1001,
    });
    const evaluation = await provider.evaluate(
      { action: 'shell:exec', scope: { command: 'bun test' } },
      {
        turnId: turn.id,
        threadId: thread.id,
        workspaceId: workspace.id,
        workspaceRootPath: workspace.rootPath,
        bridgeSessionId: session.bridgeSessionId,
      },
    );
    if (evaluation.type !== 'ask') {
      throw new Error('expected ask');
    }

    await expect(provider.awaitDecision(evaluation.approvalId)).resolves.toEqual({
      type: 'timeout',
      reason: 'approval_timeout',
    });
    await expect(store.getApproval(evaluation.approvalId)).resolves.toMatchObject({
      status: 'timed_out',
    });
    expect(canonicalEvents(store, turn.id)).toEqual([
      {
        type: 'permission.required',
        turnId: turn.id,
        approvalId: evaluation.approvalId,
        action: 'shell:exec',
      },
      {
        type: 'permission.resolved',
        turnId: turn.id,
        approvalId: evaluation.approvalId,
        decision: 'deny',
      },
    ]);
  });
});

function canonicalEvents(store: SQLiteStateStore, turnId: string): unknown[] {
  return store.database
    .query<{ canonical_json: string }, [string]>(
      'SELECT canonical_json FROM events WHERE turn_id = ? ORDER BY seq',
    )
    .all(turnId)
    .map((row) => JSON.parse(row.canonical_json));
}
