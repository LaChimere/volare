import { describe, expect, test } from 'bun:test';

import { RuntimeCapabilityRegistry } from '../../src/core/runtime-capability-registry';
import { SQLiteEventJournal } from '../../src/events/sqlite-event-journal';
import { createApp } from '../../src/server/app';
import { createServerRuntimeConfig } from '../../src/server/config';
import {
  CapturingLogger,
  createDurableApp,
  createStateStore,
  request,
  testConfig,
} from '../support/app-harness';

describe('server app security', () => {
  test('rejects unauthenticated requests and unexpected origins without CORS headers', async () => {
    const app = createApp({ config: testConfig });
    const originHeaders = {
      authorization: `Bearer ${testConfig.apiKey}`,
      Origin: 'https://evil.example',
    };

    const [missing, invalidJson, debug] = await Promise.all([
      app.fetch(new Request('http://127.0.0.1:8000/openai/v1/models')),
      app.fetch(
        request('/openai/v1/responses', {
          method: 'POST',
          headers: originHeaders,
          body: '{',
        }),
      ),
      app.fetch(request('/debug/turns/turn_missing/events', { headers: originHeaders })),
    ]);

    expect(missing.status).toBe(401);
    expect(invalidJson.status).toBe(403);
    expect(debug.status).toBe(403);
    expect(invalidJson.headers.has('access-control-allow-origin')).toBe(false);
    expect(debug.headers.has('access-control-allow-origin')).toBe(false);
  });

  test('does not leak capability diagnostics into the public capabilities projection', async () => {
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      approvalWaiter: 'notifier',
      now: () => 1000,
    });
    capabilityRegistry.updateAcpNativeCancel({
      classification: 'native-terminal-only',
      source: 'probe',
      reason: 'leaked /tmp/secret-workspace raw token 0123456789abcdef',
    });
    const app = createApp({
      config: createServerRuntimeConfig({
        VOLARE_API_KEY: '0123456789abcdef',
        VOLARE_WORKSPACE_ROOT: '/tmp/secret-workspace',
        VOLARE_COPILOT_RUNTIME_MODE: 'acp',
      }),
      capabilityRegistry,
      healthStatus: () => 'ready',
    });

    const response = await app.fetch(request('/capabilities'));

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain('0123456789abcdef');
    expect(serialized).not.toContain('/tmp/secret-workspace');
    expect(serialized).not.toContain(testConfig.projectlessWorkspaceRoot);
    expect(serialized).not.toContain(testConfig.stateDatabasePath);
    expect(serialized).not.toContain(testConfig.host);
  });

  test('keeps reserved metadata secrets out of SSE, debug, stored replay, and logs', async () => {
    const stateStore = createStateStore();
    const logger = new CapturingLogger();
    const app = createDurableApp(stateStore, { logger });

    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'metadata guard',
          metadata: {
            keep: 'safe',
            'volare.sources': { secret: 'source-secret' },
            nested: { VOLARE: { secret: 'nested-secret' } },
          },
        }),
      }),
    );

    const streamText = await createResponse.text();
    const responseId = /"id":"(resp_[^"]+)"/.exec(streamText)?.[1];
    const clientRef = await stateStore.resolveClientRef('openai-responses-v1', responseId ?? '');
    expect(clientRef).toBeDefined();
    expect(streamText).toContain('"metadata":{"keep":"safe","nested":{}}');
    expect(streamText).not.toContain('source-secret');
    expect(streamText).not.toContain('nested-secret');

    const debugText = await (
      await app.fetch(request(`/debug/turns/${clientRef?.turnId}/events`))
    ).text();
    const storedText = await (
      await app.fetch(request(`/openai/v1/responses/${responseId}`))
    ).text();
    for (const text of [debugText, storedText]) {
      expect(text).not.toContain('volare.sources');
      expect(text).not.toContain('source-secret');
      expect(text).not.toContain('nested-secret');
    }
    const logText = JSON.stringify(logger.entries);
    expect(logText).not.toContain('source-secret');
    expect(logText).not.toContain('nested-secret');
  });

  test('serves redacted debug events without exposing raw authorization headers', async () => {
    const stateStore = createStateStore();
    const eventJournal = new SQLiteEventJournal(stateStore.database);
    const workspace = await stateStore.getOrCreateWorkspace({ rootPath: process.cwd() });
    const thread = await stateStore.createThread({ workspaceId: workspace.id });
    const session = await stateStore.reserveBackendSession({
      workspaceId: workspace.id,
      threadId: thread.id,
      backend: 'mock',
    });
    await stateStore.activateBackendSession(session, { backendSessionId: 'backend_1' });
    const turn = await stateStore.createTurn({
      threadId: thread.id,
      bridgeSessionId: session.bridgeSessionId,
      model: 'copilot-agent',
    });
    await eventJournal.append({
      turnId: turn.id,
      kind: 'northbound',
      redactedRawJson: {
        headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
      },
    });
    const app = createApp({ config: testConfig, stateStore, eventJournal });

    const response = await app.fetch(request(`/debug/turns/${turn.id}/events`));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"Authorization":{"redacted":true,"charCount":13}');
    expect(text).not.toContain('Bearer secret');
  });
});
