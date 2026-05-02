import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { createApp } from '../../../src/server/app';
import { createServerRuntimeConfig } from '../../../src/server/config';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';

const config = createServerRuntimeConfig({
  AGENT_LOOM_API_KEY: '0123456789abcdef',
  AGENT_LOOM_WORKSPACE_ROOT: process.cwd(),
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      ...init.headers,
    },
  });
}

function createStateStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new SQLiteStateStore(database);
}

describe('server app', () => {
  test('rejects unauthenticated requests', async () => {
    const app = createApp({ config });

    const response = await app.fetch(new Request('http://127.0.0.1:8000/openai/v1/models'));

    expect(response.status).toBe(401);
  });

  test('rejects unexpected Origin headers with CORS disabled by default', async () => {
    const app = createApp({ config });

    const response = await app.fetch(
      request('/openai/v1/models', {
        headers: {
          origin: 'https://example.test',
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  test('serves the minimal models route', async () => {
    const app = createApp({ config });

    const response = await app.fetch(request('/openai/v1/models'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [{ id: 'copilot-agent', object: 'model', owned_by: 'github' }],
    });
  });

  test('streams a text response and serves a stored response snapshot', async () => {
    const app = createApp({ config });

    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
        }),
      }),
    );

    expect(createResponse.status).toBe(200);
    const streamText = await createResponse.text();
    expect(streamText).toContain('response.output_text.delta');
    expect(streamText).toContain('hello');
    const responseId = /"id":"(resp_[^"]+)"/.exec(streamText)?.[1];
    expect(responseId).toBeDefined();

    const storedResponse = await app.fetch(request(`/openai/v1/responses/${responseId}`));

    expect(storedResponse.status).toBe(200);
    expect(await storedResponse.json()).toMatchObject({
      id: responseId,
      status: 'completed',
      output: [{ content: [{ text: 'hello' }] }],
    });
  });

  test('serves a non-terminal response snapshot without blocking', async () => {
    const app = createApp({ config });

    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
        }),
      }),
    );
    const reader = createResponse.body?.getReader();
    const firstChunk = await reader?.read();
    const responseId = /"id":"(resp_[^"]+)"/.exec(new TextDecoder().decode(firstChunk?.value))?.[1];
    expect(responseId).toBeDefined();

    const storedResponse = await app.fetch(request(`/openai/v1/responses/${responseId}`));

    expect(storedResponse.status).toBe(200);
    expect(await storedResponse.json()).toMatchObject({
      id: responseId,
      status: 'in_progress',
      output: [],
    });

    await reader?.cancel();
  });

  test('fails previous_response_id explicitly until durable state lands', async () => {
    const app = createApp({ config });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
          previous_response_id: 'resp_missing',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        type: 'unsupported_parameter',
        message: 'previous_response_id is not supported until durable multi-turn state lands',
      },
    });
  });

  test('continues durable responses through previous_response_id on the same backend session', async () => {
    const stateStore = createStateStore();
    const workspace = await stateStore.getOrCreateWorkspace({ rootPath: process.cwd() });
    const app = createApp({ config, stateStore });

    const firstResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'first',
        }),
      }),
    );
    const firstStream = await firstResponse.text();
    const firstResponseId = /"id":"(resp_[^"]+)"/.exec(firstStream)?.[1];
    expect(firstResponseId).toBeDefined();
    expect(firstStream).toContain(
      `"type":"response.completed","sequence_number":3,"response":{"id":"${firstResponseId}"`,
    );

    const secondResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'second',
          previous_response_id: firstResponseId,
        }),
      }),
    );
    const secondStream = await secondResponse.text();
    const secondResponseId = /"id":"(resp_[^"]+)"/.exec(secondStream)?.[1];
    expect(secondResponse.status).toBe(200);
    expect(secondResponseId).toBeDefined();

    const firstRef = await stateStore.resolveClientRef(
      'openai-responses-v1',
      firstResponseId ?? '',
    );
    const secondRef = await stateStore.resolveClientRef(
      'openai-responses-v1',
      secondResponseId ?? '',
    );
    expect(firstRef).toBeDefined();
    expect(secondRef).toMatchObject({
      threadId: firstRef?.threadId,
      parentExternalId: firstResponseId,
    });
    const secondTurn = await stateStore.getTurn(secondRef?.turnId ?? '');
    expect(secondTurn).toMatchObject({ parentTurnId: firstRef?.turnId });
    expect(await stateStore.getBackendSessionByThread(firstRef?.threadId ?? '')).toMatchObject({
      workspaceId: workspace.id,
    });

    const storedSecondResponse = await app.fetch(
      request(`/openai/v1/responses/${secondResponseId}`),
    );
    expect(await storedSecondResponse.json()).toMatchObject({
      id: secondResponseId,
      status: 'completed',
      output: [{ content: [{ text: 'second' }] }],
    });
  });

  test('fails missing durable parents explicitly', async () => {
    const app = createApp({ config, stateStore: createStateStore() });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'second',
          previous_response_id: 'resp_missing',
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        type: 'not_found',
        message: 'previous_response_id was not found',
      },
    });
  });

  test('fails durable continuation when the backend session is lost', async () => {
    const stateStore = createStateStore();
    const workspace = await stateStore.getOrCreateWorkspace({ rootPath: process.cwd() });
    const thread = await stateStore.createThread({ workspaceId: workspace.id });
    const session = await stateStore.reserveBackendSession({
      workspaceId: workspace.id,
      threadId: thread.id,
      backend: 'mock',
    });
    await stateStore.updateBackendSessionStatus(session.bridgeSessionId, 'initializing', 'lost');
    const turn = await stateStore.createTurn({
      threadId: thread.id,
      bridgeSessionId: session.bridgeSessionId,
      model: 'copilot-agent',
    });
    await stateStore.bindClientRef({
      protocol: 'openai-responses-v1',
      externalId: 'resp_lost',
      threadId: thread.id,
      turnId: turn.id,
    });
    const app = createApp({ config, stateStore });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'second',
          previous_response_id: 'resp_lost',
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        type: 'session_lost',
        message: 'No active backend session exists for this thread',
      },
    });
  });

  test('rejects unsupported tool parameters', async () => {
    const app = createApp({ config });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
          tools: [{ type: 'function', name: 'do_work' }],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        type: 'unsupported_parameter',
        message: 'Client-side tools are not supported in the MVP',
      },
    });
  });

  test('rejects clearly too-short configured tokens', () => {
    expect(() => createServerRuntimeConfig({ AGENT_LOOM_API_KEY: 'short' })).toThrow(
      'AGENT_LOOM_API_KEY is too short',
    );
  });

  test('generates an ephemeral API key when none is configured', () => {
    const runtimeConfig = createServerRuntimeConfig({});

    expect(runtimeConfig.generatedApiKey).toBe(true);
    expect(runtimeConfig.apiKey).toHaveLength(64);
    expect(runtimeConfig.apiKey).toMatch(/^[a-f0-9]+$/);
  });

  test('configures the durable state database path', () => {
    expect(createServerRuntimeConfig({}).stateDatabasePath).toBe('.agent-loom/state.sqlite');
    expect(
      createServerRuntimeConfig({
        AGENT_LOOM_STATE_DB_PATH: ':memory:',
      }).stateDatabasePath,
    ).toBe(':memory:');
  });
});
