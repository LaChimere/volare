import { describe, expect, test } from 'bun:test';

import { RuntimeCapabilityRegistry } from '../../../src/core/runtime-capability-registry';
import { createApp } from '../../../src/server/app';
import { createServerRuntimeConfig } from '../../../src/server/config';
import { CapturingLogger, createInMemoryApp, request, testConfig } from '../../support/app-harness';
import { MockBackend } from '../../support/backends/mock-backend';

class FailingBackend extends MockBackend {
  override async *send(_session: never, request: { turnId: string }) {
    yield { type: 'turn.failed' as const, turnId: request.turnId, error: 'backend boom' };
  }
}

describe('server app OpenAI contract', () => {
  test('encodes malformed JSON as an OpenAI invalid_request error', async () => {
    const app = createApp({ config: testConfig });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: '{',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'invalid_request',
        message: 'Malformed JSON body',
      },
    });
  });

  test('serves stable model and capabilities schemas', async () => {
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      approvalWaiter: 'notifier',
      now: () => 1000,
    });
    capabilityRegistry.updateBackend({
      name: 'copilot-cli',
      capabilities: {
        persistentSessions: true,
        serverSideTools: true,
        permissionRequests: true,
        externalApprovalDecisions: false,
        backendInternalPauseResume: true,
        cancellation: true,
      },
    });
    const app = createApp({
      config: createServerRuntimeConfig({
        VOLARE_API_KEY: '0123456789abcdef',
        VOLARE_WORKSPACE_ROOT: process.cwd(),
        VOLARE_COPILOT_RUNTIME_MODE: 'acp',
      }),
      capabilityRegistry,
      healthStatus: () => 'ready',
    });

    const models = await app.fetch(request('/openai/v1/models?client_version=0.0.0-test'));
    const capabilities = await app.fetch(request('/capabilities'));

    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toMatchObject({
      models: [
        {
          slug: 'gpt-5.5',
          model: 'gpt-5.5',
          display_name: 'GPT-5.5',
          shell_type: 'shell_command',
          visibility: 'list',
          supported_in_api: true,
          default_reasoning_level: 'high',
          supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'low effort' },
            { reasoningEffort: 'medium', description: 'medium effort' },
            { reasoningEffort: 'high', description: 'high effort' },
            { reasoningEffort: 'xhigh', description: 'extra high effort' },
          ],
          truncation_policy: { mode: 'bytes', limit: 100_000 },
          input_modalities: ['text'],
          experimental_supported_tools: [],
          supports_parallel_tool_calls: false,
          context_window: 128_000,
        },
      ],
    });
    expect(capabilities.status).toBe(200);
    expect(capabilities.headers.get('Cache-Control')).toBe('no-store');
    await expect(capabilities.json()).resolves.toMatchObject({
      schema_version: 1,
      server: { name: 'volare', status: 'ready' },
      protocols: {
        openai_responses: {
          streaming: true,
          resumable_turns: false,
        },
      },
      runtime: {
        mode: 'acp',
        accepting_new_work: true,
        active_turn_capacity: { enabled: true, limit: 2 },
        approval_resolution: { supported: true, waiter: 'notifier' },
        sse_resume: false,
      },
      backend: {
        name: 'copilot-cli',
        capabilities: {
          persistent_sessions: true,
          server_side_tools: true,
        },
      },
    });
  });

  test('streams a completed response and serves a stored snapshot', async () => {
    const app = createInMemoryApp();

    const created = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
        }),
      }),
    );

    expect(created.status).toBe(200);
    const streamText = await created.text();
    expect(streamText).toContain('response.output_text.delta');
    expect(streamText).toContain('response.completed');
    expect(streamText).toContain('data: [DONE]');
    const responseId = /"id":"(resp_[^"]+)"/.exec(streamText)?.[1];
    expect(responseId).toBeDefined();

    const stored = await app.fetch(request(`/openai/v1/responses/${responseId}`));

    expect(stored.status).toBe(200);
    await expect(stored.json()).resolves.toMatchObject({
      id: responseId,
      status: 'completed',
      output: [{ content: [{ text: 'hello' }] }],
    });
  });

  test('encodes failed responses as completed streams with failed outcome', async () => {
    const logger = new CapturingLogger();
    const app = createInMemoryApp({ logger }, new FailingBackend());

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'fail please',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const streamText = await response.text();
    expect(streamText).toContain('response.failed');
    expect(streamText).toContain('backend boom');
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'responses stream completed',
        fields: expect.objectContaining({
          event: 'responses.stream.completed',
          responseOutcome: 'failed',
        }),
      }),
    );
  });
});
