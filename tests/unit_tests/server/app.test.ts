import { describe, expect, test } from 'bun:test';

import { createApp } from '../../../src/server/app';
import { createServerRuntimeConfig } from '../../../src/server/config';

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

describe('server app', () => {
  test('rejects unauthenticated requests', async () => {
    const app = createApp({ config });

    const response = await app.fetch(new Request('http://127.0.0.1:8000/openai/v1/models'));

    expect(response.status).toBe(401);
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
});
