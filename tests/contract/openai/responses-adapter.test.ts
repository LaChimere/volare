import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { SQLiteEventJournal } from '../../../src/events/sqlite-event-journal';
import { OpenAIResponsesAdapter } from '../../../src/northbound/openai-responses/adapter';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

describe('OpenAIResponsesAdapter contract', () => {
  test('encodes terminal and non-terminal stored response snapshots', () => {
    const adapter = new OpenAIResponsesAdapter();
    const createdAt = new Date('2026-05-02T00:00:00.000Z');

    expect(
      adapter.encodeStoredResponse(
        {
          id: 'resp_1',
          threadId: 'thread_1',
          parentTurnId: null,
          bridgeSessionId: 'bridge_session_1',
          status: 'running',
          model: 'copilot-agent',
          createdAt,
        },
        [{ type: 'text.delta', turnId: 'resp_1', delta: 'hello' }],
      ),
    ).toMatchObject({
      id: 'resp_1',
      status: 'in_progress',
      output: [{ content: [{ text: 'hello' }] }],
      usage: {
        input_tokens: 0,
        output_tokens: 2,
        total_tokens: 2,
      },
    });

    expect(
      adapter.encodeStoredResponse(
        {
          id: 'resp_1',
          threadId: 'thread_1',
          parentTurnId: null,
          bridgeSessionId: 'bridge_session_1',
          status: 'succeeded',
          model: 'copilot-agent',
          createdAt,
          completedAt: createdAt,
        },
        [{ type: 'text.delta', turnId: 'resp_1', delta: 'done' }],
        { previousResponseId: 'resp_parent' },
      ),
    ).toMatchObject({
      id: 'resp_1',
      previous_response_id: 'resp_parent',
      status: 'completed',
      output: [{ content: [{ text: 'done' }] }],
      usage: {
        input_tokens: 0,
        output_tokens: 1,
        total_tokens: 1,
      },
    });
  });

  test('encodes replayed canonical journal events as golden Responses SSE output', async () => {
    const database = new Database(':memory:');
    migrate(database);
    const store = new SQLiteStateStore(database);
    const journal = new SQLiteEventJournal(database);
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
    await journal.append({
      turnId: turn.id,
      kind: 'canonical',
      canonicalJson: { type: 'turn.succeeded', turnId: turn.id, output: { text: 'hello' } },
    });
    const adapter = new OpenAIResponsesAdapter();

    const encoded = await collectSse(
      adapter.encodeStream(journal.replay(turn.id), {
        turnId: turn.id,
        threadId: thread.id,
        externalResponseId: 'resp_golden',
        previousResponseId: null,
      }),
    );

    expect(encoded.slice(0, 4)).toEqual([
      {
        type: 'response.created',
        sequence_number: 0,
        response: { id: 'resp_golden', object: 'response', status: 'in_progress' },
      },
      {
        type: 'response.in_progress',
        sequence_number: 1,
        response: { id: 'resp_golden', object: 'response', status: 'in_progress' },
      },
      {
        type: 'response.output_item.added',
        sequence_number: 2,
        output_index: 0,
        item: {
          id: 'msg_resp_golden',
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 3,
        item_id: 'msg_resp_golden',
        output_index: 0,
        content_index: 0,
        delta: 'hello',
      },
    ]);
    expect(encoded[4]).toMatchObject({
      type: 'response.output_item.done',
      sequence_number: 4,
      item: {
        id: 'msg_resp_golden',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    });
    expect(encoded[5]).toMatchObject({
      type: 'response.completed',
      sequence_number: 5,
      response: {
        id: 'resp_golden',
        status: 'completed',
        output: [{ content: [{ text: 'hello' }] }],
        usage: {
          input_tokens: 0,
          output_tokens: 2,
          total_tokens: 2,
        },
      },
    });
    expect(encoded[6]).toBe('[DONE]');
  });

  test('preserves backend-provided usage in completed stream events', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const encoded = await collectSse(
      adapter.encodeStream(
        (async function* () {
          yield { type: 'text.delta' as const, turnId: 'turn_1', delta: 'done' };
          yield {
            type: 'turn.succeeded' as const,
            turnId: 'turn_1',
            output: { text: 'done' },
            usage: {
              inputTokens: 12,
              outputTokens: 4,
              totalTokens: 16,
              estimated: true,
              source: 'backend-estimate',
            },
          };
        })(),
        {
          turnId: 'turn_1',
          threadId: 'thread_1',
          externalResponseId: 'resp_usage',
          previousResponseId: null,
          requestInput: { message: 'ignored because backend usage wins' },
          model: 'copilot-agent',
          createdAt: new Date('2026-05-02T00:00:00.000Z'),
        },
      ),
    );

    expect(encoded[5]).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'resp_usage',
        model: 'copilot-agent',
        created_at: 1_777_680_000,
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
        },
      },
    });
  });

  test('encodes failed, interrupted, and partial terminal stream events', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const failed = await collectSse(
      adapter.encodeStream(
        (async function* () {
          yield { type: 'text.delta' as const, turnId: 'turn_1', delta: 'partial' };
          yield { type: 'turn.failed' as const, turnId: 'turn_1', error: 'boom' };
        })(),
        {
          turnId: 'turn_1',
          threadId: 'thread_1',
          externalResponseId: 'resp_failed',
          previousResponseId: null,
        },
      ),
    );
    const interrupted = await collectSse(
      adapter.encodeStream(
        (async function* () {
          yield { type: 'turn.interrupted' as const, turnId: 'turn_1', reason: 'cancelled' };
        })(),
        {
          turnId: 'turn_1',
          threadId: 'thread_1',
          externalResponseId: 'resp_interrupted',
          previousResponseId: null,
          requestInput: { message: 'please cancel' },
        },
      ),
    );
    const terminalOnly = await collectSse(
      adapter.encodeStream(
        (async function* () {
          yield { type: 'turn.succeeded' as const, turnId: 'turn_1' };
          yield { type: 'text.delta' as const, turnId: 'turn_1', delta: 'late' };
          yield { type: 'turn.failed' as const, turnId: 'turn_1', error: 'late failure' };
        })(),
        {
          turnId: 'turn_1',
          threadId: 'thread_1',
          externalResponseId: 'resp_terminal',
          previousResponseId: null,
        },
      ),
    );

    expect(failed[2]).toMatchObject({
      type: 'response.output_item.added',
      item: { id: 'msg_resp_failed', status: 'in_progress' },
    });
    expect(failed[3]).toMatchObject({
      type: 'response.output_text.delta',
      delta: 'partial',
    });
    expect(failed[4]).toMatchObject({
      type: 'response.output_item.done',
      item: {
        id: 'msg_resp_failed',
        status: 'incomplete',
        content: [{ type: 'output_text', text: 'partial' }],
      },
    });
    expect(failed[5]).toMatchObject({
      type: 'response.failed',
      response: { id: 'resp_failed', status: 'failed' },
    });
    expect(failed[6]).toBe('[DONE]');
    expect(interrupted[2]).toMatchObject({
      type: 'response.incomplete',
      response: {
        id: 'resp_interrupted',
        status: 'incomplete',
        incomplete_details: { reason: 'cancelled' },
        usage: {
          input_tokens: 4,
          output_tokens: 0,
          total_tokens: 4,
        },
      },
    });
    expect(interrupted[3]).toBe('[DONE]');
    expect(
      terminalOnly.map((event) =>
        typeof event === 'string' ? event : (event as { type?: string }).type,
      ),
    ).toEqual(['response.created', 'response.in_progress', 'response.completed', '[DONE]']);
  });
});

async function collectSse(chunks: AsyncIterable<Uint8Array>): Promise<unknown[]> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text
    .trim()
    .split('\n\n')
    .map((entry) => entry.replace(/^data: /, ''))
    .map((entry) => (entry === '[DONE]' ? entry : JSON.parse(entry)));
}
