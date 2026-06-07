import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { DefaultApprovalPolicy } from '../../../src/approvals/policy';
import { ApprovalProvider } from '../../../src/approvals/provider';
import type {
  ApprovalEvaluation,
  IApprovalPolicy,
  IPermissionRequest,
} from '../../../src/core/types';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

function createStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new SQLiteStateStore(database);
}

async function createFixture(store: SQLiteStateStore) {
  const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/volare' });
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
      provider.resolveApproval({
        approvalId: evaluation.approvalId,
        turnId: turn.id,
        bridgeSessionId: session.bridgeSessionId,
        decision: { type: 'deny', scope: 'once', reason: 'manual' },
      }),
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
      provider.resolveApproval({
        approvalId: evaluation.approvalId,
        turnId: turn.id,
        bridgeSessionId: session.bridgeSessionId,
        decision: { type: 'allow', scope: 'once' },
      }),
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
      now: () => 1000,
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
      provider.resolveApproval({
        approvalId: evaluation.approvalId,
        turnId: turn.id,
        bridgeSessionId: session.bridgeSessionId,
        decision: { type: 'allow', scope: 'once' },
      }),
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

  test('wakes same-process approval waiters without waiting for the poll interval', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    const provider = new ApprovalProvider({
      store,
      policy: new DefaultApprovalPolicy({ now: () => 1000, timeoutMs: 60_000 }),
      now: () => 1000,
      pollMs: 60_000,
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
    const waiter = provider.awaitDecision(evaluation.approvalId);

    await provider.resolveApproval({
      approvalId: evaluation.approvalId,
      turnId: turn.id,
      bridgeSessionId: session.bridgeSessionId,
      decision: { type: 'allow', scope: 'once' },
    });

    await expect(Promise.race([waiter, Bun.sleep(20).then(() => 'poll_timeout')])).resolves.toEqual(
      { type: 'allow', scope: 'once' },
    );
  });

  test('falls back to SQLite polling for cross-provider approval decisions', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    const waiterProvider = new ApprovalProvider({
      store,
      policy: new DefaultApprovalPolicy({ now: () => 1000, timeoutMs: 60_000 }),
      now: () => 1000,
      pollMs: 1,
    });
    const resolverProvider = new ApprovalProvider({ store });
    const evaluation = await waiterProvider.evaluate(
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
    const waiter = waiterProvider.awaitDecision(evaluation.approvalId);

    await resolverProvider.resolveApproval({
      approvalId: evaluation.approvalId,
      turnId: turn.id,
      bridgeSessionId: session.bridgeSessionId,
      decision: { type: 'deny', scope: 'once', reason: 'manual' },
    });

    await expect(waiter).resolves.toEqual({ type: 'deny', scope: 'once', reason: 'manual' });
  });

  test('rejects approval resolution when ownership does not match', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    const other = await createFixture(store);
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
      provider.resolveApproval({
        approvalId: evaluation.approvalId,
        turnId: other.turn.id,
        bridgeSessionId: session.bridgeSessionId,
        decision: { type: 'allow', scope: 'once' },
      }),
    ).rejects.toMatchObject({ code: 'approval_scope_mismatch' });
    await expect(store.getApproval(evaluation.approvalId)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  test('aborts pending approvals durably before polling waiters complete', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    const provider = new ApprovalProvider({
      store,
      policy: new DefaultApprovalPolicy({ now: () => 1000, timeoutMs: 5000 }),
      now: () => 1000,
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

    const waiter = provider.awaitDecision(evaluation.approvalId);
    await expect(provider.abortPendingApprovals({ reason: 'shutdown' })).resolves.toEqual({
      abortedApprovalCount: 1,
    });
    await expect(store.getApproval(evaluation.approvalId)).resolves.toMatchObject({
      status: 'aborted',
      decision: { type: 'aborted', reason: 'shutdown' },
    });
    await expect(waiter).resolves.toEqual({ type: 'aborted', reason: 'shutdown' });
    await expect(provider.abortPendingApprovals({ reason: 'shutdown' })).resolves.toEqual({
      abortedApprovalCount: 0,
    });
    await expect(
      provider.evaluate(
        { action: 'shell:exec', scope: { command: 'bun test' } },
        {
          turnId: turn.id,
          threadId: thread.id,
          workspaceId: workspace.id,
          workspaceRootPath: workspace.rootPath,
          bridgeSessionId: session.bridgeSessionId,
        },
      ),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  test('does not create pending approvals when drain starts during policy evaluation', async () => {
    const store = createStore();
    const { workspace, thread, session, turn } = await createFixture(store);
    let releasePolicy: (() => void) | undefined;
    const policy: IApprovalPolicy = {
      async evaluate(request: IPermissionRequest): Promise<ApprovalEvaluation> {
        await new Promise<void>((resolve) => {
          releasePolicy = resolve;
        });
        return {
          type: 'ask' as const,
          approvalId: 'approval_delayed',
          timeoutAt: Date.now() + 60_000,
          request,
        };
      },
    };
    const provider = new ApprovalProvider({ store, policy });
    const evaluating = provider.evaluate(
      { action: 'shell:exec', scope: { command: 'bun test' } },
      {
        turnId: turn.id,
        threadId: thread.id,
        workspaceId: workspace.id,
        workspaceRootPath: workspace.rootPath,
        bridgeSessionId: session.bridgeSessionId,
      },
    );
    const aborting = provider.abortPendingApprovals({ reason: 'shutdown' });

    releasePolicy?.();

    await expect(evaluating).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(aborting).resolves.toEqual({ abortedApprovalCount: 0 });
    await expect(store.listPendingApprovals()).resolves.toEqual([]);
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
