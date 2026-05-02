import { describe, expect, test } from 'bun:test';

import { OpenAIResponsesAdapter } from '../../../src/northbound/openai-responses/adapter';

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
});
