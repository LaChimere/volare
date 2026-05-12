import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdir, realpath } from 'node:fs/promises';
import { DefaultApprovalPolicy } from '../../../src/approvals/policy';
import { ApprovalProvider } from '../../../src/approvals/provider';
import { DurableSessionManager } from '../../../src/core/durable-session-manager';
import { InMemorySessionManager } from '../../../src/core/in-memory-session-manager';
import type {
  IAgentRequest,
  IBackendSession,
  IEventJournal,
  IWorkspace,
  IWorkspaceResolver,
} from '../../../src/core/types';
import { SQLiteEventJournal } from '../../../src/events/sqlite-event-journal';
import type { ILogBindings, ILogFields, ILogger } from '../../../src/logging/logger';
import { createApp, type IAppDependencies } from '../../../src/server/app';
import { createServerRuntimeConfig } from '../../../src/server/config';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';
import { MockBackend } from '../../support/backends/mock-backend';

const config = createServerRuntimeConfig({
  VOLARE_API_KEY: '0123456789abcdef',
  VOLARE_WORKSPACE_ROOT: process.cwd(),
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

async function getProjectlessWorkspace(store: SQLiteStateStore) {
  await mkdir(config.projectlessWorkspaceRoot, { recursive: true });
  return await store.getOrCreateWorkspace({
    rootPath: await realpath(config.projectlessWorkspaceRoot),
  });
}

function createInMemoryApp(
  overrides: Partial<IAppDependencies> = {},
  backend: MockBackend = new MockBackend(),
) {
  const workspace: IWorkspace = {
    id: 'workspace_test',
    rootPath: process.cwd(),
  };
  const workspaceResolver: IWorkspaceResolver = {
    async resolve() {
      return workspace;
    },
  };

  return createApp({
    config,
    workspaceResolver,
    sessionManager: new InMemorySessionManager({
      backend,
      workspace,
    }),
    ...overrides,
  });
}

class FailingBackend extends MockBackend {
  override async *send(_session: IBackendSession, request: IAgentRequest) {
    yield { type: 'turn.failed' as const, turnId: request.turnId, error: 'backend boom' };
  }
}

class ThrowingEventJournal implements IEventJournal {
  async append() {
    throw new Error('journal write failed');
  }

  async listByTurn() {
    return [];
  }

  async listByThread() {
    return [];
  }

  async *replay() {}

  async pruneTerminalTurnEvents() {
    return { prunedTurnCount: 0 };
  }
}

function createDurableApp(stateStore: SQLiteStateStore, overrides: Partial<IAppDependencies> = {}) {
  return createApp({
    config,
    stateStore,
    sessionManager: new DurableSessionManager({
      store: stateStore,
      backend: new MockBackend({ persistentSessions: true }),
      approvalProvider: new ApprovalProvider({
        store: stateStore,
        policy: new DefaultApprovalPolicy({ timeoutMs: config.approvalTimeoutMs }),
      }),
      cancelTimeoutMs: config.cancelTimeoutMs,
    }),
    ...overrides,
  });
}

class CapturingLogger implements ILogger {
  constructor(
    readonly entries: Array<{ level: string; fields: ILogFields; message?: string }> = [],
    readonly bindings: ILogBindings = {},
  ) {}

  child(bindings: ILogBindings): ILogger {
    return new CapturingLogger(this.entries, { ...this.bindings, ...bindings });
  }

  trace(fields: ILogFields, message?: string): void {
    this.push('trace', fields, message);
  }

  debug(fields: ILogFields, message?: string): void {
    this.push('debug', fields, message);
  }

  info(fields: ILogFields, message?: string): void {
    this.push('info', fields, message);
  }

  warn(fields: ILogFields, message?: string): void {
    this.push('warn', fields, message);
  }

  error(fields: ILogFields, message?: string): void {
    this.push('error', fields, message);
  }

  fatal(fields: ILogFields, message?: string): void {
    this.push('fatal', fields, message);
  }

  private push(level: string, fields: ILogFields, message?: string): void {
    this.entries.push({
      level,
      fields: { ...this.bindings, ...fields },
      ...(message === undefined ? {} : { message }),
    });
  }
}

describe('server app', () => {
  test('rejects unauthenticated requests', async () => {
    const app = createApp({ config });

    const response = await app.fetch(new Request('http://127.0.0.1:8000/openai/v1/models'));

    expect(response.status).toBe(401);
  });

  test('rejects malformed, wrong-scheme, and wrong-token bearer auth', async () => {
    const app = createApp({ config });

    const [malformed, wrongScheme, wrongToken] = await Promise.all([
      app.fetch(
        new Request('http://127.0.0.1:8000/openai/v1/models', {
          headers: { authorization: 'Bearer' },
        }),
      ),
      app.fetch(
        new Request('http://127.0.0.1:8000/openai/v1/models', {
          headers: { authorization: `Basic ${config.apiKey}` },
        }),
      ),
      app.fetch(
        new Request('http://127.0.0.1:8000/openai/v1/models', {
          headers: { authorization: 'Bearer 0123456789abcdeg' },
        }),
      ),
    ]);

    expect(malformed.status).toBe(401);
    expect(wrongScheme.status).toBe(401);
    expect(wrongToken.status).toBe(401);
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

  test('rejects unexpected Origin headers before non-success route handling', async () => {
    const app = createApp({
      config,
      eventJournal: new SQLiteEventJournal(createStateStore().database),
    });
    const originHeaders = {
      origin: 'https://example.test',
    };

    const [missing, invalidJson, debug] = await Promise.all([
      app.fetch(request('/missing', { headers: originHeaders })),
      app.fetch(
        request('/openai/v1/responses', {
          method: 'POST',
          headers: originHeaders,
          body: '{',
        }),
      ),
      app.fetch(request('/debug/turns/turn_missing/events', { headers: originHeaders })),
    ]);

    expect(missing.status).toBe(403);
    expect(invalidJson.status).toBe(403);
    expect(debug.status).toBe(403);
    expect(missing.headers.has('access-control-allow-origin')).toBe(false);
    expect(invalidJson.headers.has('access-control-allow-origin')).toBe(false);
    expect(debug.headers.has('access-control-allow-origin')).toBe(false);
  });

  test('returns invalid_request for malformed JSON response bodies', async () => {
    const app = createApp({ config });

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

  test('fails response creation when no session manager is configured', async () => {
    const app = createApp({ config });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'internal_error',
        message: 'Session manager is not configured',
      },
    });
  });

  test('serves a Codex-compatible models route', async () => {
    const app = createApp({ config });

    const response = await app.fetch(request('/openai/v1/models?client_version=0.0.0-test'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
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
  });

  test('logs structured request completion fields', async () => {
    const logger = new CapturingLogger();
    const app = createApp({ config, logger });

    const response = await app.fetch(request('/openai/v1/models?client_version=0.0.0-test'));

    expect(response.status).toBe(200);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: 'info',
      message: 'http request completed',
      fields: {
        component: 'server',
        event: 'http.request.completed',
        method: 'GET',
        path: '/openai/v1/models',
        status: 200,
      },
    });
    expect(typeof logger.entries[0]?.fields['requestId']).toBe('string');
    expect(typeof logger.entries[0]?.fields['durationMs']).toBe('number');
  });

  test('serves authenticated health and metrics routes', async () => {
    const app = createApp({ config, healthStatus: () => 'recovering' });

    const health = await app.fetch(request('/healthz'));
    const metrics = await app.fetch(request('/metrics'));

    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toEqual({ status: 'recovering' });
    expect(metrics.status).toBe(200);
    await expect(metrics.json()).resolves.toMatchObject({
      status: 'recovering',
      requests_total: 2,
    });
  });

  test('requires auth for health and metrics routes', async () => {
    const app = createApp({ config });

    const health = await app.fetch(new Request('http://127.0.0.1:8000/healthz'));
    const metrics = await app.fetch(new Request('http://127.0.0.1:8000/metrics'));

    expect(health.status).toBe(401);
    expect(metrics.status).toBe(401);
  });

  test('streams a text response and serves a stored response snapshot', async () => {
    const logger = new CapturingLogger();
    const app = createInMemoryApp({ logger });

    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
          reasoning: { effort: 'xhigh' },
        }),
      }),
    );

    expect(createResponse.status).toBe(200);
    const streamText = await createResponse.text();
    expect(streamText).toContain('response.output_text.delta');
    expect(streamText).toContain('hello');
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'responses stream started',
        fields: expect.objectContaining({
          event: 'responses.stream.started',
          model: 'copilot-agent',
          reasoningEffort: 'xhigh',
        }),
      }),
    );
    const streamCompletionLog = logger.entries.find(
      (entry) => entry.fields['event'] === 'responses.stream.completed',
    );
    expect(streamCompletionLog?.fields).toMatchObject({
      responseOutcome: 'succeeded',
    });
    for (const field of ['streamStartGapMs', 'firstAssistantSseFrameMs', 'sseActiveMs']) {
      expect(typeof streamCompletionLog?.fields[field]).toBe('number');
    }
    expect(typeof streamCompletionLog?.fields['sseFrameCount']).toBe('number');
    expect(
      logger.entries.some((entry) => entry.fields['event'] === 'responses.stream.interrupted'),
    ).toBe(false);
    const requestLog = logger.entries.find(
      (entry) =>
        entry.fields['event'] === 'http.request.completed' &&
        entry.fields['method'] === 'POST' &&
        entry.fields['path'] === '/openai/v1/responses',
    );
    expect(requestLog).toBeDefined();
    expect(requestLog?.fields).toMatchObject({
      status: 200,
    });
    for (const field of [
      'bodyParseMs',
      'workspaceHintMs',
      'workspaceResolveMs',
      'adapterParseMs',
      'sessionStartMs',
      'durationMs',
    ]) {
      expect(typeof requestLog?.fields[field]).toBe('number');
    }
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

  test('logs encoded response failures as completed stream outcomes', async () => {
    const logger = new CapturingLogger();
    const app = createInMemoryApp({ logger }, new FailingBackend());

    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'fail please',
        }),
      }),
    );

    expect(createResponse.status).toBe(200);
    const streamText = await createResponse.text();
    expect(streamText).toContain('response.failed');
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'responses stream completed',
        fields: expect.objectContaining({
          event: 'responses.stream.completed',
          responseOutcome: 'failed',
        }),
      }),
    );
    expect(
      logger.entries.some((entry) => entry.fields['event'] === 'responses.stream.failed'),
    ).toBe(false);
  });

  test('logs stream machinery failures without serialized error details', async () => {
    const logger = new CapturingLogger();
    const app = createInMemoryApp({ eventJournal: new ThrowingEventJournal(), logger });

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
    const reader = createResponse.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let streamText = '';
    let streamError: unknown;
    try {
      while (true) {
        const chunk = await reader?.read();
        if (chunk?.done) {
          break;
        }
        streamText += decoder.decode(chunk?.value, { stream: true });
      }
    } catch (error) {
      streamError = error;
    }
    expect(streamError).toBeDefined();
    expect(streamText).not.toContain('journal write failed');
    const streamFailureLog = logger.entries.find(
      (entry) => entry.fields['event'] === 'responses.stream.failed',
    );
    expect(streamFailureLog).toBeDefined();
    const streamFailureFields = streamFailureLog?.fields ?? {};
    expect(typeof streamFailureFields['errorCode']).toBe('string');
    expect(streamFailureFields['errorCode']).not.toBe('');
    expect(typeof streamFailureFields['sseFrameCount']).toBe('number');
    expect(streamFailureFields['error']).toBeUndefined();
    expect(JSON.stringify(logger.entries)).not.toContain('journal write failed');
  });

  test('serves a non-terminal response snapshot without blocking', async () => {
    const app = createInMemoryApp({ disconnectGraceMs: 0 });

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

  test('cancels an in-progress response by response id', async () => {
    const app = createInMemoryApp({ disconnectGraceMs: 0 });
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

    const [firstCancel, secondCancel] = await Promise.all([
      app.fetch(request(`/openai/v1/responses/${responseId}/cancel`, { method: 'POST' })),
      app.fetch(request(`/openai/v1/responses/${responseId}/cancel`, { method: 'POST' })),
    ]);

    expect(firstCancel.status).toBe(200);
    expect(secondCancel.status).toBe(200);
    await expect(firstCancel.json()).resolves.toMatchObject({
      id: responseId,
      status: 'incomplete',
    });
    await expect(secondCancel.json()).resolves.toMatchObject({
      id: responseId,
      status: 'incomplete',
    });
    await reader?.cancel();
  });

  test('rejects unauthenticated and missing response cancellations', async () => {
    const app = createInMemoryApp();

    const unauthenticated = await app.fetch(
      new Request('http://127.0.0.1:8000/openai/v1/responses/resp_missing/cancel', {
        method: 'POST',
      }),
    );
    const missing = await app.fetch(
      request('/openai/v1/responses/resp_missing/cancel', { method: 'POST' }),
    );

    expect(unauthenticated.status).toBe(401);
    expect(missing.status).toBe(404);
  });

  test('returns already-terminal responses from cancel without changing completion', async () => {
    const app = createInMemoryApp();
    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
        }),
      }),
    );
    const streamText = await createResponse.text();
    const responseId = /"id":"(resp_[^"]+)"/.exec(streamText)?.[1];
    expect(responseId).toBeDefined();

    const cancelResponse = await app.fetch(
      request(`/openai/v1/responses/${responseId}/cancel`, { method: 'POST' }),
    );

    expect(cancelResponse.status).toBe(200);
    await expect(cancelResponse.json()).resolves.toMatchObject({
      id: responseId,
      status: 'completed',
      output: [{ content: [{ text: 'hello' }] }],
    });
  });

  test('cancels an in-progress response when the SSE stream disconnects', async () => {
    const logger = new CapturingLogger();
    const app = createInMemoryApp({ disconnectGraceMs: 10, logger });
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

    const cancelPromise = reader?.cancel();
    const duringGrace = await app.fetch(request(`/openai/v1/responses/${responseId}`));
    await expect(duringGrace.json()).resolves.toMatchObject({
      id: responseId,
      status: 'in_progress',
    });
    await cancelPromise;
    const storedResponse = await app.fetch(request(`/openai/v1/responses/${responseId}`));

    expect(storedResponse.status).toBe(200);
    await expect(storedResponse.json()).resolves.toMatchObject({
      id: responseId,
      status: 'incomplete',
    });
    expect(
      logger.entries.some((entry) => entry.fields['event'] === 'responses.stream.cancelled'),
    ).toBe(false);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'responses stream interrupted',
        fields: expect.objectContaining({
          event: 'responses.stream.interrupted',
          interruptionReason: 'client_disconnect',
          interruptionPhase: 'pre_terminal',
        }),
      }),
    );
  });

  test('classifies disconnect after a terminal SSE frame as post-terminal', async () => {
    const logger = new CapturingLogger();
    const app = createInMemoryApp({ disconnectGraceMs: 0, logger });
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
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let streamText = '';
    while (!streamText.includes('response.completed')) {
      const chunk = await reader?.read();
      if (chunk?.done) {
        break;
      }
      streamText += decoder.decode(chunk?.value, { stream: true });
    }
    expect(streamText).toContain('response.completed');
    expect(streamText).not.toContain('[DONE]');

    await reader?.cancel();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'responses stream interrupted',
        fields: expect.objectContaining({
          event: 'responses.stream.interrupted',
          interruptionReason: 'client_disconnect',
          interruptionPhase: 'post_terminal',
        }),
      }),
    );
    expect(
      logger.entries.some((entry) => entry.fields['event'] === 'responses.stream.completed'),
    ).toBe(false);
  });

  test('fails previous_response_id explicitly until durable state lands', async () => {
    const app = createInMemoryApp();

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
    const workspace = await getProjectlessWorkspace(stateStore);
    const app = createDurableApp(stateStore);

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
      `"type":"response.completed","sequence_number":5,"response":{"id":"${firstResponseId}"`,
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
      previous_response_id: firstResponseId,
      status: 'completed',
      output: [{ content: [{ text: 'second' }] }],
    });
  });

  test('journals streamed canonical events for debug replay', async () => {
    const stateStore = createStateStore();
    const eventJournal = new SQLiteEventJournal(stateStore.database);
    const app = createDurableApp(stateStore, { eventJournal });

    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'journal me',
        }),
      }),
    );
    const streamText = await createResponse.text();
    const responseId = /"id":"(resp_[^"]+)"/.exec(streamText)?.[1];
    const clientRef = await stateStore.resolveClientRef('openai-responses-v1', responseId ?? '');

    expect(clientRef).toBeDefined();
    const debugResponse = await app.fetch(request(`/debug/turns/${clientRef?.turnId}/events`));

    expect(debugResponse.status).toBe(200);
    const debugBody = (await debugResponse.json()) as {
      events: Array<{ canonicalJson?: { type?: string } }>;
    };
    expect(
      debugBody.events.map(
        (event: { canonicalJson?: { type?: string } }) => event.canonicalJson?.type,
      ),
    ).toEqual(['turn.created', 'text.delta', 'turn.succeeded']);
  });

  test('serves stored durable responses from journal replay after manager restart', async () => {
    const stateStore = createStateStore();
    const eventJournal = new SQLiteEventJournal(stateStore.database);
    const app = createDurableApp(stateStore, { eventJournal });

    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'journal replay',
        }),
      }),
    );
    const streamText = await createResponse.text();
    const responseId = /"id":"(resp_[^"]+)"/.exec(streamText)?.[1];
    expect(responseId).toBeDefined();

    const restartedApp = createDurableApp(stateStore, { eventJournal });
    const storedResponse = await restartedApp.fetch(request(`/openai/v1/responses/${responseId}`));

    expect(storedResponse.status).toBe(200);
    await expect(storedResponse.json()).resolves.toMatchObject({
      id: responseId,
      status: 'completed',
      output: [{ content: [{ text: 'journal replay' }] }],
    });
  });

  test('fails missing durable parents explicitly', async () => {
    const app = createDurableApp(createStateStore());

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
    const workspace = await getProjectlessWorkspace(stateStore);
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
    const app = createDurableApp(stateStore);

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

  test('accepts Codex request tool metadata without requiring tool-call execution', async () => {
    const app = createInMemoryApp();

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'hello',
          tools: [{ type: 'function', name: 'update_plan' }],
          tool_choice: 'auto',
          parallel_tool_calls: true,
          stream: true,
          store: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('response.completed');
  });

  test('rejects clearly too-short configured tokens', () => {
    expect(() => createServerRuntimeConfig({ VOLARE_API_KEY: 'short' })).toThrow(
      'VOLARE_API_KEY must be at least 16 non-whitespace characters',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_API_KEY: '                ' })).toThrow(
      'VOLARE_API_KEY must be at least 16 non-whitespace characters',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_API_KEY: ' 0123456789abcdef ' })).toThrow(
      'VOLARE_API_KEY must be at least 16 non-whitespace characters',
    );
  });

  test('generates an ephemeral API key when none is configured', () => {
    const runtimeConfig = createServerRuntimeConfig({});

    expect(runtimeConfig.generatedApiKey).toBe(true);
    expect(runtimeConfig.apiKey).toHaveLength(64);
    expect(runtimeConfig.apiKey).toMatch(/^[a-f0-9]+$/);
  });

  test('configures the durable state database path', () => {
    expect(createServerRuntimeConfig({}).stateDatabasePath).toBe('.volare/state.sqlite');
    expect(
      createServerRuntimeConfig({
        VOLARE_STATE_DB_PATH: ':memory:',
      }).stateDatabasePath,
    ).toBe(':memory:');
  });

  test('rejects unsafe server configuration values', () => {
    expect(() => createServerRuntimeConfig({ VOLARE_CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      'Wildcard CORS origins are not allowed',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_CORS_MODE: 'browser' })).toThrow(
      'CORS browser mode is not supported',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_ALLOWED_WORKSPACE_ROOTS: '*' })).toThrow(
      'VOLARE_ALLOWED_WORKSPACE_ROOTS must contain only concrete workspace paths',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_WORKSPACE_ROOT: '*' })).toThrow(
      'VOLARE_WORKSPACE_ROOT must be a concrete workspace path',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_PROJECTLESS_WORKSPACE_ROOT: '*' })).toThrow(
      'VOLARE_PROJECTLESS_WORKSPACE_ROOT must be a concrete workspace path',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_PORT: '0' })).toThrow(
      'VOLARE_PORT must be an integer',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_CANCEL_TIMEOUT_MS: '-1' })).toThrow(
      'VOLARE_CANCEL_TIMEOUT_MS must be an integer',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_EVENT_RETENTION_DAYS: '0' })).toThrow(
      'VOLARE_EVENT_RETENTION_DAYS must be an integer',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_HTTP_IDLE_TIMEOUT_SECONDS: '256' })).toThrow(
      'VOLARE_HTTP_IDLE_TIMEOUT_SECONDS must be an integer',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_LOG_LEVEL: 'verbose' })).toThrow(
      'VOLARE_LOG_LEVEL must be one of trace, debug, info, warn, error, fatal, or silent',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_COPILOT_PERMISSION_MODE: 'ask' })).toThrow(
      'VOLARE_COPILOT_PERMISSION_MODE must be restricted, web, or full',
    );
  });

  test('parses safe timeout and retention configuration values', () => {
    expect(
      createServerRuntimeConfig({
        VOLARE_APPROVAL_TIMEOUT_MS: '60000',
        VOLARE_CANCEL_TIMEOUT_MS: '10000',
        VOLARE_DISCONNECT_GRACE_MS: '5000',
        VOLARE_HTTP_IDLE_TIMEOUT_SECONDS: '0',
        VOLARE_LOG_LEVEL: 'debug',
        VOLARE_PROJECTLESS_WORKSPACE_ROOT: '/tmp/neutralctx',
        VOLARE_MAX_ACTIVE_SESSIONS: '10',
        VOLARE_EVENT_RETENTION_DAYS: '30',
        VOLARE_COPILOT_PERMISSION_MODE: 'full',
      }),
    ).toMatchObject({
      approvalTimeoutMs: 60_000,
      cancelTimeoutMs: 10_000,
      disconnectGraceMs: 5000,
      httpIdleTimeoutSeconds: 0,
      logLevel: 'debug',
      projectlessWorkspaceRoot: '/tmp/neutralctx',
      maxActiveSessions: 10,
      eventRetentionDays: 30,
      copilotPermissionMode: 'full',
    });
    expect(createServerRuntimeConfig({}).copilotPermissionMode).toBe('full');
    expect(
      createServerRuntimeConfig({ VOLARE_COPILOT_PERMISSION_MODE: 'restricted' })
        .copilotPermissionMode,
    ).toBe('restricted');
    expect(
      createServerRuntimeConfig({ VOLARE_COPILOT_PERMISSION_MODE: 'web' }).copilotPermissionMode,
    ).toBe('web');
  });

  test('serves redacted debug events for a turn', async () => {
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
    const app = createApp({ config, stateStore, eventJournal });

    const response = await app.fetch(request(`/debug/turns/${turn.id}/events`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      turn_id: turn.id,
      events: [
        {
          turnId: turn.id,
          kind: 'northbound',
          redactedRawJson: {
            headers: {
              Authorization: { redacted: true, charCount: 13 },
              Accept: 'application/json',
            },
          },
        },
      ],
    });
  });

  test('requires auth for debug events', async () => {
    const app = createApp({
      config,
      eventJournal: new SQLiteEventJournal(createStateStore().database),
    });

    const response = await app.fetch(
      new Request('http://127.0.0.1:8000/debug/turns/turn_1/events'),
    );

    expect(response.status).toBe(401);
  });
});
