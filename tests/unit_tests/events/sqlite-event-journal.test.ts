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
  return { database, store, journal };
}

async function createTurn(store: SQLiteStateStore) {
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
  return { thread, turn };
}

describe('SQLiteEventJournal', () => {
  test('appends and replays canonical events by sequence', async () => {
    const { store, journal } = createFixture();
    const { thread, turn } = await createTurn(store);

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
    await expect(journal.listByThread(thread.id)).resolves.toMatchObject([
      { seq: 0, canonicalJson: { type: 'turn.created' } },
      { seq: 1, canonicalJson: { type: 'text.delta' } },
    ]);
  });

  test('detects sequence gaps during replay', async () => {
    const { store, journal } = createFixture();
    const { turn } = await createTurn(store);

    await journal.append({
      turnId: turn.id,
      seq: 0,
      kind: 'canonical',
      canonicalJson: { type: 'turn.created', turnId: turn.id },
    });
    await journal.append({
      turnId: turn.id,
      seq: 2,
      kind: 'canonical',
      canonicalJson: { type: 'turn.succeeded', turnId: turn.id },
    });

    await expect(Array.fromAsync(journal.replay(turn.id))).rejects.toThrow(
      'Journal sequence gap detected',
    );
  });

  test('replays incomplete non-terminal turns without requiring a terminal event', async () => {
    const { store, journal } = createFixture();
    const { turn } = await createTurn(store);

    await journal.append({
      turnId: turn.id,
      kind: 'canonical',
      canonicalJson: { type: 'text.delta', turnId: turn.id, delta: 'partial' },
    });

    await expect(store.getTurn(turn.id)).resolves.toMatchObject({ status: 'queued' });
    await expect(Array.fromAsync(journal.replay(turn.id))).resolves.toEqual([
      { type: 'text.delta', turnId: turn.id, delta: 'partial' },
    ]);
  });

  test('fails replay with a typed corruption error for malformed canonical JSON', async () => {
    const { database, store, journal } = createFixture();
    const { turn } = await createTurn(store);
    database
      .query(
        `INSERT INTO events
          (id, turn_id, seq, kind, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('event_bad', turn.id, 0, 'canonical', '{bad json', Date.now());

    await expect(Array.fromAsync(journal.replay(turn.id))).rejects.toThrow(
      'canonical_json could not be decoded',
    );
  });
});
