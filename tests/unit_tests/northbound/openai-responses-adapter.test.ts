import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { SQLiteEventJournal } from '../../../src/events/sqlite-event-journal';
import { OpenAIResponsesAdapter } from '../../../src/northbound/openai-responses/adapter';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

describe('OpenAIResponsesAdapter', () => {
  test('rejects OpenAI client-side tools honestly', async () => {
    const adapter = new OpenAIResponsesAdapter();

    await expect(
      adapter.parseRequest(
        {
          transport: 'http',
          method: 'POST',
          path: '/openai/v1/responses',
          body: {
            model: 'copilot-agent',
            input: 'hello',
            tools: [{ type: 'function', name: 'do_work' }],
          },
        },
        { workspaceId: 'workspace_1', requestId: 'request_1' },
      ),
    ).rejects.toMatchObject({
      code: 'unsupported_parameter',
    });
  });

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
    });
  });

  test('encodes replayed canonical journal events as golden Responses SSE output', async () => {
    const database = new Database(':memory:');
    migrate(database);
    const store = new SQLiteStateStore(database);
    const journal = new SQLiteEventJournal(database);
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

    expect(encoded.slice(0, 3)).toEqual([
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
        type: 'response.output_text.delta',
        sequence_number: 2,
        item_id: 'msg_resp_golden',
        output_index: 0,
        content_index: 0,
        delta: 'hello',
      },
    ]);
    expect(encoded[3]).toMatchObject({
      type: 'response.completed',
      sequence_number: 3,
      response: {
        id: 'resp_golden',
        status: 'completed',
        output: [{ content: [{ text: 'hello' }] }],
      },
    });
    expect(encoded[4]).toBe('[DONE]');
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
