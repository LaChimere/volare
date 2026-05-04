import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { SQLiteEventJournal } from '../../../src/events/sqlite-event-journal';
import { OpenAIResponsesAdapter } from '../../../src/northbound/openai-responses/adapter';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

describe('OpenAIResponsesAdapter', () => {
  test('extracts workspace hints from request metadata', async () => {
    const adapter = new OpenAIResponsesAdapter();

    await expect(
      adapter.extractWorkspaceHints({
        transport: 'http',
        method: 'POST',
        path: '/openai/v1/responses',
        body: {
          metadata: {
            workspace_root: '/tmp/volare-workspace',
          },
        },
      }),
    ).resolves.toEqual({
      source: 'client-metadata',
      requestedRoot: '/tmp/volare-workspace',
    });
    await expect(
      adapter.extractWorkspaceHints({
        transport: 'http',
        method: 'POST',
        path: '/openai/v1/responses',
        body: {
          client_metadata: {
            workspace_root: '/tmp/codex-client-workspace',
          },
        },
      }),
    ).resolves.toEqual({
      source: 'client-metadata',
      requestedRoot: '/tmp/codex-client-workspace',
    });
    await expect(
      adapter.extractWorkspaceHints({
        transport: 'http',
        method: 'POST',
        path: '/openai/v1/responses',
        headers: new Headers({
          'x-codex-turn-metadata': JSON.stringify({
            workspaces: {
              '/tmp/codex-git-workspace': {
                latest_git_commit_hash: 'abc123',
              },
            },
          }),
        }),
        body: {
          client_metadata: {
            'x-codex-installation-id': 'installation',
          },
        },
      }),
    ).resolves.toEqual({
      source: 'request-header',
      requestedRoot: '/tmp/codex-git-workspace',
    });
    await expect(
      adapter.extractWorkspaceHints({
        transport: 'http',
        method: 'POST',
        path: '/openai/v1/responses',
        headers: new Headers({
          'x-codex-turn-metadata': JSON.stringify({
            workspaces: {
              '/tmp/header-workspace': {},
            },
          }),
        }),
        body: {
          client_metadata: {
            'x-codex-installation-id': 'installation',
          },
          input: [
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: [
                    '<startup_context>',
                    'Startup context from Codex.',
                    'This is background context about recent work and machine/workspace layout. It may be incomplete or stale. Use it to inform responses, and do not repeat it back unless relevant.',
                    '',
                    '## Machine / Workspace Map',
                    'Current working directory: /tmp/codex-current-workspace',
                    'Working directory name: codex-current-workspace',
                    '</startup_context>',
                  ].join('\n'),
                },
              ],
            },
            { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
          ],
        },
      }),
    ).resolves.toEqual({
      source: 'client-context',
      requestedRoot: '/tmp/codex-current-workspace',
    });
    await expect(
      adapter.extractWorkspaceHints({
        transport: 'http',
        method: 'POST',
        path: '/openai/v1/responses',
        body: {},
      }),
    ).resolves.toEqual({ source: 'process-cwd' });
  });

  test('normalizes request metadata and client_metadata for Codex compatibility', async () => {
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
            metadata: { workspace_root: '/tmp/metadata-root', source: 'metadata' },
            client_metadata: { workspace_root: '/tmp/client-root', client: 'codex' },
          },
        },
        { workspaceId: 'workspace_1', requestId: 'request_1' },
      ),
    ).resolves.toMatchObject({
      metadata: {
        workspace_root: '/tmp/metadata-root',
        source: 'metadata',
        client: 'codex',
      },
    });
  });

  test('accepts Codex tool definitions without invoking client-side tools', async () => {
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
            tool_choice: 'auto',
            parallel_tool_calls: true,
          },
        },
        { workspaceId: 'workspace_1', requestId: 'request_1' },
      ),
    ).resolves.toMatchObject({
      input: { message: 'hello' },
    });
  });

  test('parses supported OpenAI Responses input shapes', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const context = { workspaceId: 'workspace_1', requestId: 'request_1' };
    const cases: Array<{ input: unknown; expected: string }> = [
      { input: 'hello', expected: 'hello' },
      { input: ['hello', 'world'], expected: 'hello\nworld' },
      {
        input: [
          {
            content: [{ type: 'input_text', text: 'hello' }, 'world', { type: 'ignored' }],
          },
        ],
        expected: 'hello\nworld',
      },
      {
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
          { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
          { role: 'user', content: [{ type: 'input_text', text: 'second' }] },
        ],
        expected: 'second',
      },
    ];

    for (const { input, expected } of cases) {
      await expect(
        adapter.parseRequest(
          {
            transport: 'http',
            method: 'POST',
            path: '/openai/v1/responses',
            body: { model: 'copilot-agent', input },
          },
          context,
        ),
      ).resolves.toMatchObject({ input: { message: expected } });
    }

    await expect(
      adapter.parseRequest(
        {
          transport: 'http',
          method: 'POST',
          path: '/openai/v1/responses',
          body: { model: 'copilot-agent', input: ['   ', { content: [] }] },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('extracts supported Responses attachment parts without dropping text', async () => {
    const adapter = new OpenAIResponsesAdapter();

    await expect(
      adapter.parseRequest(
        {
          transport: 'http',
          method: 'POST',
          path: '/openai/v1/responses',
          body: {
            model: 'copilot-agent',
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: 'describe these inputs' },
                  {
                    type: 'input_image',
                    image_url: 'data:image/png;base64,AAAA',
                    detail: 'low',
                  },
                  {
                    type: 'input_file',
                    filename: 'notes.txt',
                    file_id: 'file_123',
                  },
                ],
              },
            ],
          },
        },
        { workspaceId: 'workspace_1', requestId: 'request_1' },
      ),
    ).resolves.toMatchObject({
      input: {
        message: 'describe these inputs',
        attachments: [
          {
            kind: 'image',
            uri: 'data:image/png;base64,AAAA',
            mediaType: 'image/png',
            metadata: { detail: 'low' },
          },
          {
            kind: 'file',
            name: 'notes.txt',
            uri: 'file_123',
            metadata: { file_id: 'file_123' },
          },
        ],
      },
    });
  });

  test('only associates attachments from the latest user message', async () => {
    const adapter = new OpenAIResponsesAdapter();

    await expect(
      adapter.parseRequest(
        {
          transport: 'http',
          method: 'POST',
          path: '/openai/v1/responses',
          body: {
            model: 'copilot-agent',
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: 'first request' },
                  {
                    type: 'input_image',
                    image_url: 'data:image/png;base64,OLD',
                  },
                ],
              },
              { role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] },
              {
                role: 'user',
                content: [{ type: 'input_text', text: 'second request' }],
              },
            ],
          },
        },
        { workspaceId: 'workspace_1', requestId: 'request_1' },
      ),
    ).resolves.toMatchObject({
      input: {
        message: 'second request',
        conversationHistory: [
          { role: 'user', content: 'first request' },
          { role: 'assistant', content: 'first answer' },
        ],
      },
    });

    const parsed = await adapter.parseRequest(
      {
        transport: 'http',
        method: 'POST',
        path: '/openai/v1/responses',
        body: {
          model: 'copilot-agent',
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'first request' },
                { type: 'input_image', image_url: 'data:image/png;base64,OLD' },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'second request' },
                { type: 'input_file', filename: 'current.txt', file_id: 'file_current' },
              ],
            },
          ],
        },
      },
      { workspaceId: 'workspace_1', requestId: 'request_1' },
    );

    expect(parsed.input.attachments).toEqual([
      {
        kind: 'file',
        name: 'current.txt',
        uri: 'file_current',
        metadata: { file_id: 'file_current' },
      },
    ]);
  });

  test('rejects invalid Responses request boundary shapes', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const context = { workspaceId: 'workspace_1', requestId: 'request_1' };
    const request = (body: unknown) => ({
      transport: 'http' as const,
      method: 'POST',
      path: '/openai/v1/responses',
      body,
    });

    await expect(
      adapter.parseRequest(request({ model: '', input: 'hello' }), context),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Responses request requires a model',
    });
    await expect(
      adapter.parseRequest(request({ model: 'copilot-agent', input: null }), context),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Responses request requires text input',
    });
    await expect(
      adapter.parseRequest(request({ model: 'copilot-agent', input: 123 }), context),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Responses request requires text input',
    });
    await expect(
      adapter.parseRequest(
        request({ model: 'copilot-agent', input: 'hello', tools: { type: 'function' } }),
        context,
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Responses request tools must be an array',
    });
    await expect(
      adapter.parseRequest(
        request({ model: 'copilot-agent', input: 'hello', stream: false }),
        context,
      ),
    ).rejects.toMatchObject({
      code: 'unsupported_parameter',
      message: 'Responses request stream=false is not supported; Volare streams every response',
    });
  });

  test('accepts unsupported Codex controls without failing ordinary requests', async () => {
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
            reasoning: { effort: 'medium' },
            text: { verbosity: 'high' },
          },
        },
        { workspaceId: 'workspace_1', requestId: 'request_1' },
      ),
    ).resolves.toMatchObject({
      input: { message: 'hello' },
    });
  });

  test('extracts full-history Responses input into latest message and conversation history', async () => {
    const adapter = new OpenAIResponsesAdapter();

    await expect(
      adapter.parseRequest(
        {
          transport: 'http',
          method: 'POST',
          path: '/openai/v1/responses',
          body: {
            model: 'copilot-agent',
            instructions: 'Be concise.',
            input: [
              { role: 'system', content: [{ text: 'Project context.' }] },
              { role: 'user', content: [{ text: 'First request' }] },
              { role: 'assistant', content: [{ text: 'First answer' }] },
              { role: 'user', content: [{ text: 'Follow-up' }] },
            ],
          },
        },
        { workspaceId: 'workspace_1', requestId: 'request_1' },
      ),
    ).resolves.toMatchObject({
      input: {
        message: 'Follow-up',
        systemInstructions: 'Be concise.\n\nProject context.',
        conversationHistory: [
          { role: 'user', content: 'First request' },
          { role: 'assistant', content: 'First answer' },
        ],
      },
    });
  });

  test('rejects full-history Responses input that does not end with a user message', async () => {
    const adapter = new OpenAIResponsesAdapter();

    await expect(
      adapter.parseRequest(
        {
          transport: 'http',
          method: 'POST',
          path: '/openai/v1/responses',
          body: {
            model: 'copilot-agent',
            input: [
              { role: 'user', content: [{ text: 'Question' }] },
              { role: 'assistant', content: [{ text: 'Answer' }] },
            ],
          },
        },
        { workspaceId: 'workspace_1', requestId: 'request_1' },
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Responses request input must end with a user message',
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

  test('echoes request metadata on encoded Responses snapshots', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const createdAt = new Date('2026-05-02T00:00:00.000Z');
    const events = [
      {
        type: 'turn.created' as const,
        turnId: 'turn_1',
        requestMetadata: { workspace_root: '/tmp/project', client: 'codex-desktop' },
      },
      { type: 'text.delta' as const, turnId: 'turn_1', delta: 'done' },
      { type: 'turn.succeeded' as const, turnId: 'turn_1', output: { text: 'done' } },
    ];

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
        events,
      ),
    ).toMatchObject({
      metadata: { workspace_root: '/tmp/project', client: 'codex-desktop' },
    });

    const encoded = await collectSse(
      adapter.encodeStream(toAsyncIterable(events), {
        turnId: 'turn_1',
        threadId: 'thread_1',
        externalResponseId: 'resp_metadata',
        previousResponseId: null,
        requestMetadata: { workspace_root: '/tmp/project', client: 'codex-desktop' },
        model: 'copilot-agent',
        createdAt,
      }),
    );

    expect(encoded[5]).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'resp_metadata',
        metadata: { workspace_root: '/tmp/project', client: 'codex-desktop' },
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

  test('encodes failed and interrupted terminal stream events', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const failed = await collectSse(
      adapter.encodeStream(
        (async function* () {
          yield { type: 'turn.failed' as const, turnId: 'turn_1', error: 'boom' };
        })(),
        {
          turnId: 'turn_1',
          threadId: 'thread_1',
          externalResponseId: 'resp_failed',
          previousResponseId: null,
          requestInput: { message: 'please fail' },
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

    expect(failed[2]).toMatchObject({
      type: 'response.failed',
      response: {
        id: 'resp_failed',
        status: 'failed',
        error: { code: 'internal_error', message: 'boom' },
        usage: {
          input_tokens: 3,
          output_tokens: 0,
          total_tokens: 3,
        },
      },
    });
    expect(failed[3]).toBe('[DONE]');
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
  });

  test('closes partial text output items before failed terminal stream events', async () => {
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
  });

  test('stops encoding after the first terminal stream event', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const encoded = await collectSse(
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

    expect(
      encoded.map((event) =>
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

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}
