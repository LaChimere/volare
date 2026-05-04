import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { DurableSessionManager } from '../../../src/core/durable-session-manager';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalEvaluation,
  IAgentBackend,
  IAgentRequest,
  IApprovalProvider,
  IBackendCapabilities,
  IBackendSession,
  ICancelResult,
  ICreateSessionOptions,
  IWorkspace,
} from '../../../src/core/types';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

function createStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new SQLiteStateStore(database);
}

function capabilities(): IBackendCapabilities {
  return {
    persistentSessions: true,
    serverSideTools: true,
    permissionRequests: true,
    externalApprovalDecisions: false,
    backendInternalPauseResume: true,
    cancellation: true,
  };
}

class TerminalOmittingBackend implements IAgentBackend {
  readonly name = 'test-backend';
  resumeCount = 0;
  cancelCount = 0;
  disposeCount = 0;
  cancelResult: ICancelResult = { status: 'cancelled' };

  capabilities(): IBackendCapabilities {
    return capabilities();
  }

  async createSession(
    workspace: IWorkspace,
    options: ICreateSessionOptions,
  ): Promise<IBackendSession> {
    return {
      bridgeSessionId: options.bridgeSessionId,
      backendSessionId: `backend_${options.bridgeSessionId}`,
      workspaceId: workspace.id,
      threadId: options.threadId,
      status: 'active',
    };
  }

  async resumeSession(session: IBackendSession): Promise<IBackendSession> {
    this.resumeCount += 1;
    return session;
  }

  async *send(_session: IBackendSession, request: IAgentRequest): AsyncIterable<AgentEvent> {
    yield { type: 'text.delta', turnId: request.turnId, delta: 'partial' } satisfies AgentEvent;
  }

  async cancel(): Promise<ICancelResult> {
    this.cancelCount += 1;
    return this.cancelResult;
  }

  async disposeSession(): Promise<void> {
    this.disposeCount += 1;
  }
}

class CreateFailingBackend extends TerminalOmittingBackend {
  override async createSession(): Promise<IBackendSession> {
    throw new Error('backend failed to start');
  }
}

class PermissionBackend extends TerminalOmittingBackend {
  readonly submittedDecisions: ApprovalDecision[] = [];

  constructor(readonly externalApprovalDecisions: boolean) {
    super();
  }

  override capabilities(): IBackendCapabilities {
    return { ...capabilities(), externalApprovalDecisions: this.externalApprovalDecisions };
  }

  override async *send(
    _session: IBackendSession,
    request: IAgentRequest,
  ): AsyncIterable<AgentEvent> {
    yield {
      type: 'permission.required',
      turnId: request.turnId,
      approvalId: 'approval_backend_1',
      request: { action: 'shell:exec', scope: { command: 'bun test' } },
    } satisfies AgentEvent;
    yield { type: 'text.delta', turnId: request.turnId, delta: 'approved' } satisfies AgentEvent;
    yield {
      type: 'turn.succeeded',
      turnId: request.turnId,
      output: { text: 'approved' },
    } satisfies AgentEvent;
  }

  async submitApprovalDecision(
    _session: IBackendSession,
    _approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    this.submittedDecisions.push(decision);
  }
}

class HangingPermissionBackend extends PermissionBackend {
  override async *send(
    _session: IBackendSession,
    request: IAgentRequest,
  ): AsyncIterable<AgentEvent> {
    yield {
      type: 'permission.required',
      turnId: request.turnId,
      approvalId: 'approval_backend_1',
      request: { action: 'shell:exec', scope: { command: 'bun test' } },
    } satisfies AgentEvent;
    await new Promise(() => {});
  }
}

class StubApprovalProvider implements IApprovalProvider {
  constructor(
    readonly evaluation: ApprovalEvaluation,
    readonly awaitedDecision: ApprovalDecision = { type: 'allow', scope: 'once' },
  ) {}

  async evaluate(): Promise<ApprovalEvaluation> {
    return this.evaluation;
  }

  async resolve() {
    return { status: 'resolved' as const, decision: this.awaitedDecision };
  }

  async awaitDecision(): Promise<ApprovalDecision> {
    return this.awaitedDecision;
  }
}

describe('DurableSessionManager', () => {
  test('marks reserved backend sessions lost when activation fails', async () => {
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/volare' });
    const manager = new DurableSessionManager({
      store,
      backend: new CreateFailingBackend(),
    });

    await expect(
      manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      ),
    ).rejects.toThrow('backend failed to start');

    expect(
      store.database.query<{ status: string }, []>('SELECT status FROM backend_sessions').all(),
    ).toEqual([{ status: 'lost' }]);
  });

  test('resumes existing sessions and synthesizes one terminal event', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend });
    try {
      const first = await manager.startTurn(
        {
          model: 'copilot-agent',
          input: { message: 'hello' },
          clientRef: { protocol: 'test-protocol', externalId: 'resp_1' },
        },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );
      const firstEvents = [];
      for await (const event of manager.streamTurn(first)) {
        firstEvents.push(event);
      }

      const second = await manager.startTurn(
        {
          threadId: first.thread.id,
          parentTurnId: first.turn.id,
          model: 'copilot-agent',
          input: { message: 'again' },
          clientRef: {
            protocol: 'test-protocol',
            externalId: 'resp_2',
            parentProtocol: 'test-protocol',
            parentExternalId: 'resp_1',
          },
        },
        { workspaceId: workspace.id, requestId: 'request_2' },
      );
      const secondEvents = [];
      for await (const event of manager.streamTurn(second)) {
        secondEvents.push(event);
      }

      expect(backend.resumeCount).toBe(1);
      expect(second.session.bridgeSessionId).toBe(first.session.bridgeSessionId);
      expect(second.turn.parentTurnId).toBe(first.turn.id);
      expect(firstEvents.filter((event) => event.type === 'turn.interrupted')).toHaveLength(1);
      expect(secondEvents.filter((event) => event.type === 'turn.interrupted')).toHaveLength(1);
      await expect(store.getTurn(first.turn.id)).resolves.toMatchObject({ status: 'interrupted' });
      await expect(store.getTurn(second.turn.id)).resolves.toMatchObject({
        status: 'interrupted',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects continuation when the request workspace does not match the thread', async () => {
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/volare' });
    const otherWorkspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/other-volare' });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend });
    const first = await manager.startTurn(
      { model: 'copilot-agent', input: { message: 'hello' } },
      { workspaceId: workspace.id, requestId: 'request_1' },
    );

    await expect(
      manager.startTurn(
        {
          threadId: first.thread.id,
          parentTurnId: first.turn.id,
          model: 'copilot-agent',
          input: { message: 'wrong workspace' },
        },
        { workspaceId: otherWorkspace.id, requestId: 'request_2' },
      ),
    ).rejects.toThrow('Thread belongs to a different workspace');
  });

  test('fails resume when the persisted workspace path changes', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    try {
      const store = createStore();
      const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
      const backend = new TerminalOmittingBackend();
      const manager = new DurableSessionManager({ store, backend });
      const first = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );
      await rm(root, { recursive: true, force: true });

      await expect(
        manager.startTurn(
          {
            threadId: first.thread.id,
            parentTurnId: first.turn.id,
            model: 'copilot-agent',
            input: { message: 'resume after delete' },
          },
          { workspaceId: workspace.id, requestId: 'request_2' },
        ),
      ).rejects.toThrow('Workspace root changed before resume');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('delegates non-terminal turn cancellation to the backend', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      await expect(manager.cancelTurn(resolved.turn.id)).resolves.toEqual({ status: 'cancelled' });

      expect(backend.cancelCount).toBe(1);
      await expect(store.getTurn(resolved.turn.id)).resolves.toMatchObject({ status: 'cancelled' });
      expect(manager.getEvents(resolved.turn.id)).toContainEqual({
        type: 'turn.cancelled',
        turnId: resolved.turn.id,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('interrupts the turn and abandons the session when backend force-cancel times out', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalOmittingBackend();
    backend.cancelResult = { status: 'timed_out' };
    const manager = new DurableSessionManager({ store, backend });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      await expect(manager.cancelTurn(resolved.turn.id)).resolves.toEqual({ status: 'timed_out' });

      expect(backend.cancelCount).toBe(1);
      expect(backend.disposeCount).toBe(1);
      await expect(store.getTurn(resolved.turn.id)).resolves.toMatchObject({
        status: 'interrupted',
      });
      await expect(
        store.getBackendSession(resolved.session.bridgeSessionId),
      ).resolves.toMatchObject({
        status: 'abandoned',
      });
      expect(manager.getEvents(resolved.turn.id)).toContainEqual({
        type: 'turn.interrupted',
        turnId: resolved.turn.id,
        reason: 'force_cancel_timeout_exceeded',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports already-terminal turns without claiming they were cancelled', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );
      await store.updateTurnStatus(resolved.turn.id, 'queued', 'succeeded', Date.now());

      await expect(manager.cancelTurn(resolved.turn.id)).resolves.toEqual({
        status: 'already_terminal',
      });

      expect(backend.cancelCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('stores client refs under the caller protocol instead of an adapter literal', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend });
    try {
      const resolved = await manager.startTurn(
        {
          model: 'agent-model',
          input: { message: 'hello' },
          clientRef: { protocol: 'custom-protocol', externalId: 'custom_1' },
        },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      await expect(store.resolveClientRef('custom-protocol', 'custom_1')).resolves.toMatchObject({
        turnId: resolved.turn.id,
      });
      await expect(store.resolveClientRef('openai-responses-v1', 'custom_1')).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects backend send when the resolved session scope is inconsistent', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      await expect(
        Array.fromAsync(
          manager.streamTurn({
            ...resolved,
            request: { ...resolved.request, workspaceId: 'workspace_wrong' },
          }),
        ),
      ).rejects.toThrow('Backend session does not match request scope');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('delivers approval decisions to backends that support external decisions', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new PermissionBackend(true);
    const manager = new DurableSessionManager({
      store,
      backend,
      approvalProvider: new StubApprovalProvider({
        type: 'ask',
        approvalId: 'approval_backend_1',
        timeoutAt: Date.now() + 1000,
        request: { action: 'shell:exec', scope: { command: 'bun test' } },
      }),
    });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      const events = await Array.fromAsync(manager.streamTurn(resolved));

      expect(backend.submittedDecisions).toEqual([{ type: 'allow', scope: 'once' }]);
      expect(events.map((event) => event.type)).toEqual([
        'turn.created',
        'permission.required',
        'permission.resolved',
        'text.delta',
        'turn.succeeded',
      ]);
      await expect(store.getTurn(resolved.turn.id)).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed when backend approval decision delivery is unsupported', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new PermissionBackend(false);
    const manager = new DurableSessionManager({
      store,
      backend,
      approvalProvider: new StubApprovalProvider({
        type: 'deny',
        reason: 'policy_denied',
        request: { action: 'shell:exec', scope: { command: 'bun test' } },
      }),
    });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      const events = await Array.fromAsync(manager.streamTurn(resolved));

      expect(backend.submittedDecisions).toEqual([]);
      expect(events.map((event) => event.type)).toEqual([
        'turn.created',
        'permission.required',
        'turn.failed',
      ]);
      await expect(store.getTurn(resolved.turn.id)).resolves.toMatchObject({ status: 'failed' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('forces interruption when backend does not finish after approval timeout', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new HangingPermissionBackend(true);
    backend.cancelResult = { status: 'timed_out' };
    const manager = new DurableSessionManager({
      store,
      backend,
      cancelTimeoutMs: 1,
      approvalProvider: new StubApprovalProvider(
        {
          type: 'ask',
          approvalId: 'approval_backend_1',
          timeoutAt: Date.now() - 1,
          request: { action: 'shell:exec', scope: { command: 'bun test' } },
        },
        { type: 'timeout', reason: 'approval_timeout' },
      ),
    });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      const events = await Array.fromAsync(manager.streamTurn(resolved));

      expect(backend.submittedDecisions).toEqual([{ type: 'timeout', reason: 'approval_timeout' }]);
      expect(backend.cancelCount).toBe(1);
      expect(backend.disposeCount).toBe(1);
      expect(events.map((event) => event.type)).toEqual([
        'turn.created',
        'permission.required',
        'permission.resolved',
        'turn.interrupted',
      ]);
      expect(events.at(-1)).toMatchObject({
        type: 'turn.interrupted',
        reason: 'approval_timeout_exceeded',
      });
      await expect(store.getTurn(resolved.turn.id)).resolves.toMatchObject({
        status: 'interrupted',
      });
      await expect(
        store.getBackendSession(resolved.session.bridgeSessionId),
      ).resolves.toMatchObject({
        status: 'abandoned',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
