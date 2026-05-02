import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { DurableSessionManager } from '../../../src/core/durable-session-manager';
import type {
  AgentBackendInterface,
  AgentEvent,
  AgentRequestInterface,
  BackendCapabilitiesInterface,
  BackendSessionInterface,
  CancelResultInterface,
  CreateSessionOptionsInterface,
  WorkspaceInterface,
} from '../../../src/core/types';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

function createStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new SQLiteStateStore(database);
}

function capabilities(): BackendCapabilitiesInterface {
  return {
    persistentSessions: true,
    serverSideTools: true,
    permissionRequests: true,
    externalApprovalDecisions: false,
    backendInternalPauseResume: true,
    cancellation: true,
  };
}

class TerminalOmittingBackend implements AgentBackendInterface {
  readonly name = 'test-backend';
  resumeCount = 0;

  capabilities(): BackendCapabilitiesInterface {
    return capabilities();
  }

  async createSession(
    workspace: WorkspaceInterface,
    options: CreateSessionOptionsInterface,
  ): Promise<BackendSessionInterface> {
    return {
      bridgeSessionId: options.bridgeSessionId,
      backendSessionId: `backend_${options.bridgeSessionId}`,
      workspaceId: workspace.id,
      threadId: options.threadId,
      status: 'active',
    };
  }

  async resumeSession(session: BackendSessionInterface): Promise<BackendSessionInterface> {
    this.resumeCount += 1;
    return session;
  }

  async *send(_session: BackendSessionInterface, request: AgentRequestInterface) {
    yield { type: 'text.delta', turnId: request.turnId, delta: 'partial' } satisfies AgentEvent;
  }

  async cancel(): Promise<CancelResultInterface> {
    return { status: 'cancelled' };
  }

  async disposeSession(): Promise<void> {}
}

class CreateFailingBackend extends TerminalOmittingBackend {
  override async createSession(): Promise<BackendSessionInterface> {
    throw new Error('backend failed to start');
  }
}

describe('DurableSessionManager', () => {
  test('marks reserved backend sessions lost when activation fails', async () => {
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });
    const manager = new DurableSessionManager({
      store,
      backend: new CreateFailingBackend(),
      workspace,
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
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend, workspace });
    const first = await manager.startTurn(
      { model: 'copilot-agent', input: { message: 'hello' }, clientRef: { externalId: 'resp_1' } },
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
        clientRef: { externalId: 'resp_2', parentExternalId: 'resp_1' },
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
    await expect(store.getTurn(second.turn.id)).resolves.toMatchObject({ status: 'interrupted' });
  });

  test('rejects continuation when the request workspace does not match the thread', async () => {
    const store = createStore();
    const workspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/agent-loom' });
    const otherWorkspace = await store.getOrCreateWorkspace({ rootPath: '/tmp/other-agent-loom' });
    const backend = new TerminalOmittingBackend();
    const manager = new DurableSessionManager({ store, backend, workspace });
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
});
