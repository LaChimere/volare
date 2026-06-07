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
import type { ILogBindings, ILogFields, ILogger } from '../../../src/logging/logger';
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

class DeferredCancelBackend extends TerminalOmittingBackend {
  resolveCancel!: (result: ICancelResult) => void;
  readonly cancelStarted: Promise<void>;
  #resolveCancelStarted!: () => void;

  constructor() {
    super();
    this.cancelStarted = new Promise<void>((resolve) => {
      this.#resolveCancelStarted = resolve;
    });
  }

  override async cancel(): Promise<ICancelResult> {
    this.cancelCount += 1;
    this.#resolveCancelStarted();
    return await new Promise<ICancelResult>((resolve) => {
      this.resolveCancel = resolve;
    });
  }
}

class SuccessfulBackend extends TerminalOmittingBackend {
  override async *send(
    _session: IBackendSession,
    request: IAgentRequest,
  ): AsyncIterable<AgentEvent> {
    yield { type: 'text.delta', turnId: request.turnId, delta: 'done' } satisfies AgentEvent;
    yield {
      type: 'turn.succeeded',
      turnId: request.turnId,
      output: { text: 'done' },
    } satisfies AgentEvent;
  }
}

class TerminalThenHangingBackend extends TerminalOmittingBackend {
  override async *send(
    _session: IBackendSession,
    request: IAgentRequest,
  ): AsyncIterable<AgentEvent> {
    yield {
      type: 'turn.succeeded',
      turnId: request.turnId,
      output: { text: 'done' },
    } satisfies AgentEvent;
    await new Promise(() => {});
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

class CapturingLogger implements ILogger {
  constructor(
    readonly entries: Array<{ level: string; fields: ILogFields; message?: string }> = [],
    readonly bindings: ILogBindings = {},
  ) {}

  child(bindings: ILogBindings): ILogger {
    return new CapturingLogger(this.entries, { ...this.bindings, ...bindings });
  }

  trace(fields: ILogFields, message?: string): void {
    this.push('trace', fields, message);
  }

  debug(fields: ILogFields, message?: string): void {
    this.push('debug', fields, message);
  }

  info(fields: ILogFields, message?: string): void {
    this.push('info', fields, message);
  }

  warn(fields: ILogFields, message?: string): void {
    this.push('warn', fields, message);
  }

  error(fields: ILogFields, message?: string): void {
    this.push('error', fields, message);
  }

  fatal(fields: ILogFields, message?: string): void {
    this.push('fatal', fields, message);
  }

  private push(level: string, fields: ILogFields, message?: string): void {
    this.entries.push({
      level,
      fields: { ...this.bindings, ...fields },
      ...(message === undefined ? {} : { message }),
    });
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

  async resolveApproval() {
    return { status: 'resolved' as const, decision: this.awaitedDecision };
  }

  async abortPendingApprovals() {
    return { abortedApprovalCount: 0 };
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

  test('logs durable turn startup and stream summary metrics', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const logger = new CapturingLogger();
    const manager = new DurableSessionManager({
      store,
      backend: new SuccessfulBackend(),
      logger,
    });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'hello' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      const events = await Array.fromAsync(manager.streamTurn(resolved));

      expect(events.map((event) => event.type)).toEqual([
        'turn.created',
        'text.delta',
        'turn.succeeded',
      ]);
      const turnStarted = logger.entries.find((entry) => entry.fields['event'] === 'turn.started');
      expect(turnStarted?.fields).toMatchObject({
        component: 'session-manager',
        event: 'turn.started',
        requestId: 'request_1',
        workspaceId: workspace.id,
        threadId: resolved.thread.id,
        turnId: resolved.turn.id,
        bridgeSessionId: resolved.session.bridgeSessionId,
        reusedThread: false,
      });
      for (const field of [
        'stateStartMs',
        'threadResolveMs',
        'backendSessionResolveMs',
        'turnPersistMs',
      ]) {
        expect(typeof turnStarted?.fields[field]).toBe('number');
      }
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          message: 'turn stream started',
          fields: expect.objectContaining({
            event: 'turn.stream.started',
            activeTurnCount: 1,
          }),
        }),
      );
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          message: 'turn stream terminal event',
          fields: expect.objectContaining({
            event: 'turn.stream.terminal',
            terminalType: 'turn.succeeded',
            activeTurnCount: 1,
            canonicalEventCount: 3,
          }),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not leak active turn count when a stream iterator is closed early', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const logger = new CapturingLogger();
    const manager = new DurableSessionManager({
      store,
      backend: new TerminalOmittingBackend(),
      logger,
    });
    try {
      const first = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'first' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );
      const firstIterator = manager.streamTurn(first)[Symbol.asyncIterator]();
      await firstIterator.next();
      await firstIterator.return?.();

      const second = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'second' } },
        { workspaceId: workspace.id, requestId: 'request_2' },
      );
      const secondIterator = manager.streamTurn(second)[Symbol.asyncIterator]();
      await secondIterator.next();
      await secondIterator.return?.();

      const streamStartedLogs = logger.entries.filter(
        (entry) => entry.fields['event'] === 'turn.stream.started',
      );
      expect(streamStartedLogs.map((entry) => entry.fields['activeTurnCount'])).toEqual([1, 1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test('enforces active-turn capacity without creating rejected turn state', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend, maxActiveTurns: 1 });
    try {
      const outcomes = await Promise.allSettled([
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'first' } },
          { workspaceId: workspace.id, requestId: 'request_1' },
        ),
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'second' } },
          { workspaceId: workspace.id, requestId: 'request_2' },
        ),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect(rejected?.reason).toMatchObject({
        code: 'capacity_exhausted',
        cause: expect.objectContaining({
          scope: 'active_turns',
          limit: 1,
          activeTurnCount: 1,
          retryAfterMs: 1000,
        }),
      });
      await expect(
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'third' } },
          { workspaceId: workspace.id, requestId: 'request_3' },
        ),
      ).rejects.toMatchObject({
        code: 'capacity_exhausted',
        cause: expect.objectContaining({
          scope: 'active_turns',
          limit: 1,
          activeTurnCount: 1,
          retryAfterMs: 1000,
        }),
      });
      const row = store.database
        .query<{ count: number }, []>('SELECT count(*) AS count FROM turns')
        .get();
      expect(row?.count).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('releases active-turn capacity when startTurn fails before creating turn state', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const otherWorkspace = await store.getOrCreateWorkspace({
      rootPath: await realpath(await mkdtemp(path.join(import.meta.dir, 'durable-other-'))),
    });
    const thread = await store.createThread({ workspaceId: otherWorkspace.id });
    const manager = new DurableSessionManager({
      store,
      backend: new TerminalOmittingBackend(),
      maxActiveTurns: 1,
    });
    try {
      await expect(
        manager.startTurn(
          { threadId: thread.id, model: 'copilot-agent', input: { message: 'wrong workspace' } },
          { workspaceId: workspace.id, requestId: 'request_1' },
        ),
      ).rejects.toMatchObject({ code: 'workspace_mismatch' });

      await expect(
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'after failure' } },
          { workspaceId: workspace.id, requestId: 'request_2' },
        ),
      ).resolves.toMatchObject({ turn: { status: 'queued' } });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(otherWorkspace.rootPath, { recursive: true, force: true });
    }
  });

  test('does not release active-turn capacity until cancellation reaches terminal state', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new DeferredCancelBackend();
    const manager = new DurableSessionManager({ store, backend, maxActiveTurns: 1 });
    try {
      const resolved = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'first' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );
      const cancel = manager.cancelTurn(resolved.turn.id);
      await backend.cancelStarted;

      await expect(
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'while cancelling' } },
          { workspaceId: workspace.id, requestId: 'request_2' },
        ),
      ).rejects.toMatchObject({ code: 'capacity_exhausted' });

      backend.resolveCancel({ status: 'cancelled' });
      await expect(cancel).resolves.toEqual({ status: 'cancelled' });
      await expect(
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'after terminal cancel' } },
          { workspaceId: workspace.id, requestId: 'request_3' },
        ),
      ).resolves.toMatchObject({ turn: { status: 'queued' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('releases active-turn capacity exactly once after terminal stream event', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new SuccessfulBackend();
    const manager = new DurableSessionManager({ store, backend, maxActiveTurns: 1 });
    try {
      const first = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'first' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );
      for await (const _ of manager.streamTurn(first)) {
      }

      await expect(manager.cancelTurn(first.turn.id)).resolves.toEqual({
        status: 'already_terminal',
      });
      await expect(
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'second' } },
          { workspaceId: workspace.id, requestId: 'request_2' },
        ),
      ).resolves.toMatchObject({ turn: { status: 'queued' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('releases active-turn capacity when terminal event is observed before backend cleanup ends', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalThenHangingBackend();
    const manager = new DurableSessionManager({ store, backend, maxActiveTurns: 1 });
    let iterator: AsyncIterator<AgentEvent> | undefined;
    try {
      const first = await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'first' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );
      iterator = manager.streamTurn(first)[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'turn.created' },
      });
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'turn.succeeded' },
      });
      await expect(
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'second' } },
          { workspaceId: workspace.id, requestId: 'request_2' },
        ),
      ).resolves.toMatchObject({ turn: { status: 'queued' } });
    } finally {
      await iterator?.return?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not release active-turn capacity when cancelling turns not reserved by this manager', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'durable-workspace-'));
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: await realpath(root) });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend, maxActiveTurns: 1 });
    try {
      const foreignThread = await store.createThread({ workspaceId: workspace.id });
      const foreignSession = await store.reserveBackendSession({
        workspaceId: workspace.id,
        threadId: foreignThread.id,
        backend: backend.name,
      });
      await store.activateBackendSession(foreignSession, { backendSessionId: 'backend_foreign' });
      const foreignTerminalTurn = await store.createTurn({
        threadId: foreignThread.id,
        bridgeSessionId: foreignSession.bridgeSessionId,
        model: 'copilot-agent',
      });
      await store.updateTurnStatus(foreignTerminalTurn.id, 'queued', 'succeeded', Date.now());
      const foreignQueuedTurn = await store.createTurn({
        threadId: foreignThread.id,
        bridgeSessionId: foreignSession.bridgeSessionId,
        model: 'copilot-agent',
      });

      await manager.startTurn(
        { model: 'copilot-agent', input: { message: 'first' } },
        { workspaceId: workspace.id, requestId: 'request_1' },
      );

      await expect(manager.cancelTurn(foreignTerminalTurn.id)).resolves.toEqual({
        status: 'already_terminal',
      });
      await expect(
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'after terminal foreign cancel' } },
          { workspaceId: workspace.id, requestId: 'request_2' },
        ),
      ).rejects.toMatchObject({ code: 'capacity_exhausted' });

      await expect(manager.cancelTurn(foreignQueuedTurn.id)).resolves.toEqual({
        status: 'cancelled',
      });
      await expect(
        manager.startTurn(
          { model: 'copilot-agent', input: { message: 'after queued foreign cancel' } },
          { workspaceId: workspace.id, requestId: 'request_3' },
        ),
      ).rejects.toMatchObject({ code: 'capacity_exhausted' });
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
