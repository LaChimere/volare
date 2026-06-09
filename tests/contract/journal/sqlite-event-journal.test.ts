import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { SQLiteEventJournal } from '../../../src/events/sqlite-event-journal';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

function createFixture() {
  const database = new Database(':memory:');
  migrate(database);
  const store = new SQLiteStateStore(database);
  const journal = new SQLiteEventJournal(database);
  return { store, journal };
}

async function createTurn(store: SQLiteStateStore) {
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
  return { turn };
}

describe('SQLiteEventJournal contract', () => {
  test('replays canonical events in sequence order', async () => {
    const { store, journal } = createFixture();
    const { turn } = await createTurn(store);

    await journal.append({
      turnId: turn.id,
      kind: 'canonical',
      canonicalJson: { type: 'turn.created', turnId: turn.id },
    });
    await journal.append({
      turnId: turn.id,
      kind: 'canonical',
      canonicalJson: { type: 'text.delta', turnId: turn.id, delta: 'hello' },
    });

    await expect(Array.fromAsync(journal.replay(turn.id))).resolves.toEqual([
      { type: 'turn.created', turnId: turn.id },
      { type: 'text.delta', turnId: turn.id, delta: 'hello' },
    ]);
  });

  test('replays incomplete non-terminal turn events without synthesizing terminal output', async () => {
    const { store, journal } = createFixture();
    const { turn } = await createTurn(store);

    await journal.append({
      turnId: turn.id,
      kind: 'canonical',
      canonicalJson: { type: 'text.delta', turnId: turn.id, delta: 'partial' },
    });

    await expect(Array.fromAsync(journal.replay(turn.id))).resolves.toEqual([
      { type: 'text.delta', turnId: turn.id, delta: 'partial' },
    ]);
  });

  test('retention tombstones expired terminal-turn journals', async () => {
    const { store, journal } = createFixture();
    const { turn } = await createTurn(store);
    await store.updateTurnStatus(turn.id, 'queued', 'succeeded', 100);
    await journal.append({
      turnId: turn.id,
      kind: 'canonical',
      canonicalJson: { type: 'turn.created', turnId: turn.id },
    });
    await journal.append({
      turnId: turn.id,
      kind: 'canonical',
      canonicalJson: { type: 'turn.succeeded', turnId: turn.id },
    });

    await expect(journal.pruneTerminalTurnEvents({ completedBefore: 101 })).resolves.toEqual({
      prunedTurnCount: 1,
    });
    await expect(Array.fromAsync(journal.replay(turn.id))).rejects.toMatchObject({
      code: 'journal_expired',
    });
    await expect(journal.listByTurn(turn.id)).resolves.toMatchObject([
      {
        seq: 0,
        kind: 'security',
        redactionJson: { retention: 'expired' },
      },
    ]);
  });
});
