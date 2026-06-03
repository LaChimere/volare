import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { ShutdownController } from '../../../src/server/shutdown';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

function createStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new SQLiteStateStore(database);
}

describe('ShutdownController', () => {
  test('stops accepting requests and interrupts leftover state idempotently', async () => {
    const store = createStore();
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
    const server = new FakeServer();
    const cleanupCalls: string[] = [];
    const shutdown = new ShutdownController({
      server,
      stateStore: store,
      cleanup: () => {
        cleanupCalls.push('cleanup');
      },
    });

    const [first, second] = await Promise.all([shutdown.shutdown(), shutdown.shutdown()]);

    expect(first).toEqual({ interruptedTurnCount: 1, abandonedSessionCount: 1 });
    expect(second).toBe(first);
    expect(server.stopCalls).toEqual([false, true]);
    expect(cleanupCalls).toEqual(['cleanup']);
    await expect(store.getTurn(turn.id)).resolves.toMatchObject({ status: 'interrupted' });
    await expect(store.getBackendSession(session.bridgeSessionId)).resolves.toMatchObject({
      status: 'abandoned',
    });
  });

  test('force-stops the server when state recovery fails', async () => {
    const server = new FakeServer();
    const shutdown = new ShutdownController({
      server,
      stateStore: createFailingRecoveryStore(),
    });

    await expect(shutdown.shutdown()).rejects.toThrow('recovery failed');

    expect(server.stopCalls).toEqual([false, true]);
  });

  test('force-stops and recovers state when graceful stop fails', async () => {
    const store = createStore();
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
    const server = new FakeServer({ failGraceful: true });
    const shutdown = new ShutdownController({ server, stateStore: store });

    await expect(shutdown.shutdown()).rejects.toThrow('graceful stop failed');

    expect(server.stopCalls).toEqual([false, true]);
    await expect(store.getTurn(turn.id)).resolves.toMatchObject({ status: 'interrupted' });
    await expect(store.getBackendSession(session.bridgeSessionId)).resolves.toMatchObject({
      status: 'abandoned',
    });
  });

  test('force-stops and recovers state when cleanup fails', async () => {
    const store = createStore();
    const server = new FakeServer();
    const shutdown = new ShutdownController({
      server,
      stateStore: store,
      cleanup: () => {
        throw new Error('cleanup failed');
      },
    });

    await expect(shutdown.shutdown()).rejects.toThrow('cleanup failed');

    expect(server.stopCalls).toEqual([false, true]);
  });

  test('runs cleanup before waiting for graceful stop completion', async () => {
    const store = createStore();
    let releaseGracefulStop: (() => void) | undefined;
    const server: FakeServer = new FakeServer({
      gracefulStopPromise: new Promise<void>((resolve) => {
        releaseGracefulStop = resolve;
      }),
    });
    const events: string[] = [];
    const shutdown = new ShutdownController({
      server,
      stateStore: store,
      cleanup: () => {
        events.push('cleanup');
        releaseGracefulStop?.();
      },
    });

    await expect(shutdown.shutdown()).resolves.toEqual({
      interruptedTurnCount: 0,
      abandonedSessionCount: 0,
    });

    expect(events).toEqual(['cleanup']);
    expect(server.stopCalls).toEqual([false, true]);
  });
});

function createFailingRecoveryStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new FailingRecoveryStore(database);
}

class FakeServer {
  readonly stopCalls: boolean[] = [];

  constructor(
    readonly options: {
      failGraceful?: boolean;
      failForce?: boolean;
      gracefulStopPromise?: Promise<void>;
    } = {},
  ) {}

  stop(force = false): void | Promise<void> {
    this.stopCalls.push(force);
    if (!force && this.options.failGraceful) {
      throw new Error('graceful stop failed');
    }
    if (force && this.options.failForce) {
      throw new Error('force stop failed');
    }
    if (!force && this.options.gracefulStopPromise) {
      return this.options.gracefulStopPromise;
    }
  }
}

class FailingRecoveryStore extends SQLiteStateStore {
  override async recoverStartupState(): Promise<never> {
    throw new Error('recovery failed');
  }
}
