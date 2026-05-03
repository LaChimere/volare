import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { RedactionFailedError, type RedactorInterface } from '../../../src/events/redaction';
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

  test('redacts event payloads before persistence', async () => {
    const { store, journal } = createFixture();
    const { turn } = await createTurn(store);

    await journal.append({
      turnId: turn.id,
      kind: 'northbound',
      redactedRawJson: {
        headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
        prompt: 'secret prompt',
      },
    });

    await expect(journal.listByTurn(turn.id)).resolves.toMatchObject([
      {
        redactedRawJson: {
          headers: {
            Authorization: { redacted: true, charCount: 13 },
            Accept: 'application/json',
          },
          prompt: { redacted: true, charCount: 13 },
        },
        redactionJson: {
          redactedRawJson: {
            redactedPaths: ['$.headers.Authorization', '$.prompt'],
          },
        },
      },
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

  test('fails closed when redaction fails before persistence', async () => {
    const { database, store } = createFixture();
    const { turn } = await createTurn(store);
    const journal = new SQLiteEventJournal(database, new FailingRedactor());

    await expect(
      journal.append({
        turnId: turn.id,
        kind: 'northbound',
        redactedRawJson: { prompt: 'unredacted secret' },
      }),
    ).rejects.toThrow('Redaction failed before journal persistence');

    await expect(journal.listByTurn(turn.id)).resolves.toEqual([
      expect.objectContaining({
        kind: 'security',
        canonicalJson: {
          type: 'turn.failed',
          turnId: turn.id,
          error: { code: 'redaction_failed' },
        },
        redactionJson: {
          redactedPaths: ['$'],
          failure: 'redaction_failed',
        },
      }),
    ]);
    expect(
      database
        .query<{ redacted_raw_json: string | null }, []>('SELECT redacted_raw_json FROM events')
        .all(),
    ).toEqual([{ redacted_raw_json: null }]);
  });

  test('does not mask redaction failures when the security marker cannot be persisted', async () => {
    const { database } = createFixture();
    const journal = new SQLiteEventJournal(database, new FailingRedactor());

    await expect(
      journal.append({
        turnId: 'turn_missing',
        kind: 'northbound',
        redactedRawJson: { prompt: 'unredacted secret' },
      }),
    ).rejects.toThrow('Redaction failed before journal persistence');
  });

  test('prunes only whole terminal-turn journals and leaves replay tombstones', async () => {
    const { store, journal } = createFixture();
    const { turn: terminalTurn } = await createTurn(store);
    const { turn: nonTerminalTurn } = await createTurn(store);
    await store.updateTurnStatus(terminalTurn.id, 'queued', 'succeeded', 100);
    await journal.append({
      turnId: terminalTurn.id,
      kind: 'canonical',
      canonicalJson: { type: 'turn.created', turnId: terminalTurn.id },
    });
    await journal.append({
      turnId: terminalTurn.id,
      kind: 'canonical',
      canonicalJson: { type: 'turn.succeeded', turnId: terminalTurn.id },
    });
    await journal.append({
      turnId: nonTerminalTurn.id,
      kind: 'canonical',
      canonicalJson: { type: 'text.delta', turnId: nonTerminalTurn.id, delta: 'partial' },
    });

    await expect(journal.pruneTerminalTurnEvents({ completedBefore: 101 })).resolves.toEqual({
      prunedTurnCount: 1,
    });

    await expect(Array.fromAsync(journal.replay(terminalTurn.id))).rejects.toMatchObject({
      code: 'journal_expired',
    });
    await expect(Array.fromAsync(journal.replay(nonTerminalTurn.id))).resolves.toEqual([
      { type: 'text.delta', turnId: nonTerminalTurn.id, delta: 'partial' },
    ]);
    await expect(journal.listByTurn(terminalTurn.id)).resolves.toMatchObject([
      {
        seq: 0,
        kind: 'security',
        redactionJson: { retention: 'expired' },
      },
    ]);
    await expect(journal.pruneTerminalTurnEvents({ completedBefore: 101 })).resolves.toEqual({
      prunedTurnCount: 0,
    });
  });
});

class FailingRedactor implements RedactorInterface {
  redact(): never {
    throw new RedactionFailedError('test', new Error('boom'));
  }
}
