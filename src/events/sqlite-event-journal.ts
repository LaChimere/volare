import type { Database } from 'bun:sqlite';

import { AgentLoomError, toAgentLoomError } from '../core/errors';
import { createId } from '../core/ids';
import type {
  AgentEvent,
  EventJournalInterface,
  JournalEventInterface,
  ThreadId,
  TurnId,
} from '../core/types';
import { type LoggerInterface, NoopLogger } from '../logging/logger';
import { DefaultRedactor, RedactionFailedError, type RedactorInterface } from './redaction';

type JournalEventRow = {
  id: string;
  turn_id: string;
  seq: number;
  kind: JournalEventInterface['kind'];
  redacted_raw_json: string | null;
  canonical_json: string | null;
  encoded_json: string | null;
  redaction_json: string | null;
  created_at: number;
};

export class SQLiteEventJournal implements EventJournalInterface {
  readonly #redactor: RedactorInterface;
  readonly #logger: LoggerInterface;

  constructor(
    readonly database: Database,
    redactor: RedactorInterface | undefined = undefined,
    logger: LoggerInterface = new NoopLogger(),
  ) {
    this.database.run('PRAGMA foreign_keys = ON');
    this.#redactor = redactor ?? new DefaultRedactor();
    this.#logger = logger.child({ component: 'event-journal' });
  }

  async append(event: JournalEventInterface): Promise<void> {
    const now = Date.now();
    const seq = event.seq ?? nextEventSeq(this.database, event.turnId);
    let redacted: JournalEventInterface;
    try {
      redacted = this.#redactEvent(event);
    } catch (error) {
      if (error instanceof RedactionFailedError) {
        this.#logger.error(
          {
            event: 'journal.redaction_failed',
            turnId: event.turnId,
            kind: event.kind,
            errorCode: 'redaction_failed',
          },
          'journal event redaction failed',
        );
        try {
          insertSecurityRedactionFailure(this.database, event.turnId, now);
        } catch (markerError) {
          const markerAgentError = toAgentLoomError(markerError);
          this.#logger.error(
            {
              event: 'journal.redaction_marker_failed',
              turnId: event.turnId,
              kind: event.kind,
              errorCode: markerAgentError.code,
              error: markerAgentError,
            },
            'journal redaction failure marker could not be persisted',
          );
        }
      }
      throw error;
    }
    insertJournalEvent(this.database, { ...redacted, seq }, now);
    this.#logger.debug(
      {
        event: 'journal.appended',
        turnId: event.turnId,
        seq,
        kind: event.kind,
        hasCanonicalJson: event.canonicalJson !== undefined,
        hasEncodedJson: event.encodedJson !== undefined,
        hasRedactedRawJson: event.redactedRawJson !== undefined,
      },
      'journal event appended',
    );
  }

  #redactEvent(event: JournalEventInterface): JournalEventInterface {
    const redactionJson: Record<string, unknown> = isRecord(event.redactionJson)
      ? { ...event.redactionJson }
      : {};
    const redacted: JournalEventInterface = { ...event };
    for (const key of ['redactedRawJson', 'canonicalJson', 'encodedJson'] as const) {
      if (event[key] === undefined) {
        continue;
      }
      const result = this.#redactor.redact(event[key]);
      redacted[key] = result.value;
      redactionJson[key] = result.redactionJson;
    }
    return { ...redacted, redactionJson };
  }

  async listByTurn(turnId: TurnId): Promise<JournalEventInterface[]> {
    const rows = this.database
      .query<JournalEventRow, [string]>(
        `SELECT id, turn_id, seq, kind, redacted_raw_json, canonical_json,
                encoded_json, redaction_json, created_at
         FROM events
         WHERE turn_id = ?
         ORDER BY seq`,
      )
      .all(turnId);
    this.#logger.debug(
      { event: 'journal.list_by_turn', turnId, eventCount: rows.length },
      'journal events listed by turn',
    );
    return rows.map(journalEventFromRow);
  }

  async listByThread(threadId: ThreadId): Promise<JournalEventInterface[]> {
    const rows = this.database
      .query<JournalEventRow, [string]>(
        `SELECT events.id, events.turn_id, events.seq, events.kind, events.redacted_raw_json,
                events.canonical_json, events.encoded_json, events.redaction_json, events.created_at
         FROM events
         JOIN turns ON turns.id = events.turn_id
         WHERE turns.thread_id = ?
         ORDER BY turns.created_at, events.seq`,
      )
      .all(threadId);
    this.#logger.debug(
      { event: 'journal.list_by_thread', threadId, eventCount: rows.length },
      'journal events listed by thread',
    );
    return rows.map(journalEventFromRow);
  }

  async *replay(turnId: TurnId): AsyncIterable<AgentEvent> {
    const events = await this.listByTurn(turnId);
    if (isRetentionTombstone(events)) {
      this.#logger.warn(
        { event: 'journal.replay.expired', turnId },
        'journal replay failed because retention expired',
      );
      throw new AgentLoomError('journal_expired', 'Journal retention expired for this turn');
    }
    for (const [index, event] of events.entries()) {
      if (event.seq !== index) {
        this.#logger.error(
          {
            event: 'journal.replay.sequence_gap',
            turnId,
            expectedSeq: index,
            actualSeq: event.seq,
            eventId: event.id,
          },
          'journal replay sequence gap',
        );
        throw new AgentLoomError('journal_corrupted', 'Journal sequence gap detected', {
          cause: { expectedSeq: index, actualSeq: event.seq },
        });
      }
      if (event.canonicalJson === undefined) {
        continue;
      }
      yield decodeCanonicalEvent(event);
    }
    this.#logger.debug(
      { event: 'journal.replay.completed', turnId, eventCount: events.length },
      'journal replay completed',
    );
  }

  async pruneTerminalTurnEvents(input: {
    completedBefore: number;
  }): Promise<{ prunedTurnCount: number }> {
    const transaction = this.database.transaction(() => {
      const turnIds = this.database
        .query<{ id: string }, [number]>(
          `SELECT turns.id
           FROM turns
           WHERE turns.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
             AND turns.completed_at IS NOT NULL
             AND turns.completed_at < ?
             AND EXISTS (SELECT 1 FROM events WHERE events.turn_id = turns.id)
             AND NOT EXISTS (
               SELECT 1 FROM events
               WHERE events.turn_id = turns.id
                 AND events.kind = 'security'
                 AND events.redaction_json LIKE '%"retention":"expired"%'
             )`,
        )
        .all(input.completedBefore)
        .map((row) => row.id);
      const now = Date.now();
      for (const turnId of turnIds) {
        this.database.query('DELETE FROM events WHERE turn_id = ?').run(turnId);
        insertJournalEvent(
          this.database,
          {
            turnId,
            seq: 0,
            kind: 'security',
            redactionJson: { retention: 'expired' },
          },
          now,
        );
      }
      return { prunedTurnCount: turnIds.length };
    });
    const result = transaction();
    this.#logger.info(
      {
        event: 'journal.pruned',
        completedBefore: input.completedBefore,
        prunedTurnCount: result.prunedTurnCount,
      },
      'journal events pruned',
    );
    return result;
  }
}

function journalEventFromRow(row: JournalEventRow): JournalEventInterface {
  return {
    id: row.id,
    turnId: row.turn_id,
    seq: row.seq,
    kind: row.kind,
    ...(row.redacted_raw_json
      ? { redactedRawJson: parseEventJson(row.redacted_raw_json, 'redacted_raw_json') }
      : {}),
    ...(row.canonical_json
      ? { canonicalJson: parseEventJson(row.canonical_json, 'canonical_json') }
      : {}),
    ...(row.encoded_json ? { encodedJson: parseEventJson(row.encoded_json, 'encoded_json') } : {}),
    ...(row.redaction_json
      ? { redactionJson: parseEventJson(row.redaction_json, 'redaction_json') }
      : {}),
    createdAt: row.created_at,
  };
}

function decodeCanonicalEvent(event: JournalEventInterface): AgentEvent {
  if (!event.canonicalJson || typeof event.canonicalJson !== 'object') {
    throw new AgentLoomError('journal_corrupted', 'Canonical event could not be decoded', {
      cause: { eventId: event.id },
    });
  }
  return event.canonicalJson as AgentEvent;
}

function isRetentionTombstone(events: JournalEventInterface[]): boolean {
  return (
    events.length === 1 &&
    events[0]?.kind === 'security' &&
    isRecord(events[0].redactionJson) &&
    events[0].redactionJson['retention'] === 'expired'
  );
}

function parseEventJson(value: string, column: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new AgentLoomError('journal_corrupted', `${column} could not be decoded`, { cause });
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function insertJournalEvent(database: Database, event: JournalEventInterface, now: number): void {
  database
    .query(
      `INSERT INTO events
        (id, turn_id, seq, kind, redacted_raw_json, canonical_json, encoded_json, redaction_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id ?? createId('event'),
      event.turnId,
      event.seq ?? nextEventSeq(database, event.turnId),
      event.kind,
      jsonOrNull(event.redactedRawJson),
      jsonOrNull(event.canonicalJson),
      jsonOrNull(event.encodedJson),
      jsonOrNull(event.redactionJson),
      event.createdAt ?? now,
    );
}

function insertSecurityRedactionFailure(database: Database, turnId: TurnId, now: number): void {
  insertJournalEvent(
    database,
    {
      turnId,
      kind: 'security',
      canonicalJson: {
        type: 'turn.failed',
        turnId,
        error: { code: 'redaction_failed' },
      },
      redactionJson: {
        redactedPaths: ['$'],
        failure: 'redaction_failed',
      },
    },
    now,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nextEventSeq(database: Database, turnId: TurnId): number {
  const row = database
    .query<{ next_seq: number }, [string]>(
      'SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM events WHERE turn_id = ?',
    )
    .get(turnId);
  return row?.next_seq ?? 0;
}
