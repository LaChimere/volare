import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdir, realpath } from 'node:fs/promises';
import { DefaultApprovalPolicy } from '../../../src/approvals/policy';
import { ApprovalProvider } from '../../../src/approvals/provider';
import { DurableSessionManager } from '../../../src/core/durable-session-manager';
import { VolareError } from '../../../src/core/errors';
import { InMemorySessionManager } from '../../../src/core/in-memory-session-manager';
import { RuntimeCapabilityRegistry } from '../../../src/core/runtime-capability-registry';
import type {
  IAgentRequest,
  IBackendSession,
  ICancelResult,
  IEventJournal,
  IResolvedTurn,
  ISessionManager,
  IWorkspace,
  IWorkspaceResolver,
} from '../../../src/core/types';
import { SQLiteEventJournal } from '../../../src/events/sqlite-event-journal';
import type { ILogBindings, ILogFields, ILogger } from '../../../src/logging/logger';
import { OpenAIResponsesAdapter } from '../../../src/northbound/openai-responses/adapter';
import { createApp, type IAppDependencies } from '../../../src/server/app';
import { createServerRuntimeConfig } from '../../../src/server/config';
import { migrate } from '../../../src/state/migrations';
import { SQLiteStateStore } from '../../../src/state/sqlite-store';
import { MockBackend } from '../../support/backends/mock-backend';

const config = createServerRuntimeConfig({
  VOLARE_API_KEY: '0123456789abcdef',
  VOLARE_WORKSPACE_ROOT: process.cwd(),
});
const unmediatedConfig = createServerRuntimeConfig({
  VOLARE_API_KEY: '0123456789abcdef',
  VOLARE_WORKSPACE_ROOT: process.cwd(),
  VOLARE_COPILOT_MCP_MODE: 'unmediated',
  VOLARE_COPILOT_PERMISSION_MODE: 'web',
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

class ToolObservedBackend extends MockBackend {
  override async *send(_session: IBackendSession, request: IAgentRequest) {
    yield {
      type: 'tool.observed' as const,
      turnId: request.turnId,
      toolName: 'fixture',
    };
    yield { type: 'text.delta' as const, turnId: request.turnId, delta: request.input.message };
    yield {
      type: 'turn.succeeded' as const,
      turnId: request.turnId,
      output: { text: request.input.message },
    };
  }
}

class AuditOrderingBackend extends MockBackend {
  sawAuditBeforeSend = false;

  constructor(private readonly logger: CapturingLogger) {
    super();
  }

  override async *send(_session: IBackendSession, request: IAgentRequest) {
    this.sawAuditBeforeSend = this.logger.entries.some(
      (entry) => entry.fields['event'] === 'turn.audit',
    );
    this.logger.info(
      {
        event: 'test.backend.send.entered',
        sawAuditBeforeSend: this.sawAuditBeforeSend,
      },
      'backend send entered',
    );
    yield { type: 'text.delta' as const, turnId: request.turnId, delta: request.input.message };
    yield {
      type: 'turn.succeeded' as const,
      turnId: request.turnId,
      output: { text: request.input.message },
    };
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

class CancelCleanupFailingSessionManager extends InMemorySessionManager {
  override async cancelTurn(_turnId: string): Promise<ICancelResult> {
    throw new Error('cancel cleanup failed');
  }
}

class TrackingCancelSessionManager extends InMemorySessionManager {
  readonly cancelledTurnIds: string[] = [];

  override async cancelTurn(turnId: string): Promise<ICancelResult> {
    this.cancelledTurnIds.push(turnId);
    return await super.cancelTurn(turnId);
  }
}

class ThrowingEncodeAdapter extends OpenAIResponsesAdapter {
  override encodeStream(): AsyncIterable<Uint8Array> {
    throw new Error('stream setup failed');
  }
}

function createDurableApp(stateStore: SQLiteStateStore, overrides: Partial<IAppDependencies> = {}) {
  const approvalProvider = new ApprovalProvider({
    store: stateStore,
    policy: new DefaultApprovalPolicy({ timeoutMs: config.approvalTimeoutMs }),
  });
  return createApp({
    config,
    stateStore,
    sessionManager: new DurableSessionManager({
      store: stateStore,
      backend: new MockBackend({ persistentSessions: true }),
      approvalProvider,
      cancelTimeoutMs: config.cancelTimeoutMs,
    }),
    approvalNotifier: approvalProvider,
    ...overrides,
  });
}

async function createApprovalFixture(store: SQLiteStateStore) {
  const workspace = await getProjectlessWorkspace(store);
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
  const approval = await store.createApproval({
    turnId: turn.id,
    bridgeSessionId: session.bridgeSessionId,
    request: { action: 'shell:exec', scope: { command: 'bun test' } },
    timeoutAt: Date.now() + 60_000,
  });
  return { workspace, thread, session, turn, approval };
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

  test('maps active-turn capacity exhaustion to retryable OpenAI error', async () => {
    const capacityManager: ISessionManager = {
      async startTurn(): Promise<IResolvedTurn> {
        throw new VolareError('capacity_exhausted', 'Active turn capacity is exhausted', {
          cause: { retryAfterMs: 2500 },
        });
      },
      async getTurn() {
        return null;
      },
      getEvents() {
        return [];
      },
      async *streamTurn() {},
      async cancelTurn() {
        return { status: 'not_found' };
      },
    };
    const app = createInMemoryApp({ sessionManager: capacityManager });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'copilot-agent', input: 'hello', stream: true }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(response.headers.get('X-Volare-Retry-After-Ms')).toBe('2500');
    expect(response.headers.get('X-Volare-Capacity-Scope')).toBe('active_turns');
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'rate_limit_error',
        message: 'Active turn capacity is exhausted',
        code: 'capacity_exhausted',
        param: null,
      },
    });
  });

  test('maps ACP worker admission timeout to retryable OpenAI capacity error', async () => {
    const capacityManager: ISessionManager = {
      async startTurn(): Promise<IResolvedTurn> {
        throw new VolareError(
          'backend_worker_admission_timeout',
          'ACP worker admission timed out',
          {
            cause: { scope: 'backend_worker_admission', retryAfterMs: 1250 },
          },
        );
      },
      async getTurn() {
        return null;
      },
      getEvents() {
        return [];
      },
      async *streamTurn() {},
      async cancelTurn() {
        return { status: 'not_found' };
      },
    };
    const app = createInMemoryApp({ sessionManager: capacityManager });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'copilot-agent', input: 'hello', stream: true }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(response.headers.get('X-Volare-Retry-After-Ms')).toBe('1250');
    expect(response.headers.get('X-Volare-Capacity-Scope')).toBe('backend_worker_admission');
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'rate_limit_error',
        message: 'ACP worker admission timed out',
        code: 'backend_worker_admission_timeout',
        param: null,
      },
    });
  });

  test('maps admission shutdown drain to retryable service unavailable error', async () => {
    const unavailableManager: ISessionManager = {
      async startTurn(): Promise<IResolvedTurn> {
        throw new VolareError('service_unavailable', 'ACP worker admission is shutting down', {
          cause: { retryAfterMs: 1500, reason: 'shutdown' },
        });
      },
      async getTurn() {
        return null;
      },
      getEvents() {
        return [];
      },
      async *streamTurn() {},
      async cancelTurn() {
        return { status: 'not_found' };
      },
    };
    const app = createInMemoryApp({ sessionManager: unavailableManager });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'copilot-agent', input: 'hello', stream: true }),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(response.headers.get('X-Volare-Retry-After-Ms')).toBe('1500');
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'service_unavailable',
        message: 'ACP worker admission is shutting down',
      },
    });
  });

  test('cancels an accepted turn when response stream setup fails', async () => {
    const workspace: IWorkspace = {
      id: 'workspace_test',
      rootPath: process.cwd(),
    };
    const sessionManager = new TrackingCancelSessionManager({
      backend: new MockBackend(),
      workspace,
    });
    const app = createInMemoryApp({
      adapter: new ThrowingEncodeAdapter(),
      sessionManager,
    });

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'copilot-agent', input: 'hello', stream: true }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'internal_error',
        message: 'stream setup failed',
      },
    });
    expect(sessionManager.cancelledTurnIds).toHaveLength(1);
  });

  test('resolves pending approvals through the Volare control endpoint', async () => {
    const stateStore = createStateStore();
    const { session, turn, approval } = await createApprovalFixture(stateStore);
    const app = createDurableApp(stateStore);

    const response = await app.fetch(
      request(`/control/approvals/${approval.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          turn_id: turn.id,
          bridge_session_id: session.bridgeSessionId,
          decision: { type: 'allow', scope: 'once' },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      approval_id: approval.id,
      turn_id: turn.id,
      bridge_session_id: session.bridgeSessionId,
      status: 'resolved',
      decision: { type: 'allow', scope: 'once' },
    });
    await expect(stateStore.getApproval(approval.id)).resolves.toMatchObject({
      status: 'allowed',
      decision: { type: 'allow', scope: 'once' },
    });
  });

  test('rejects approval resolution with mismatched ownership', async () => {
    const stateStore = createStateStore();
    const { session, turn, approval } = await createApprovalFixture(stateStore);
    const other = await createApprovalFixture(stateStore);
    const app = createDurableApp(stateStore);

    const response = await app.fetch(
      request(`/control/approvals/${approval.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          turn_id: other.turn.id,
          bridge_session_id: session.bridgeSessionId,
          decision: { type: 'allow', scope: 'once' },
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'approval_scope_mismatch',
        message: 'Approval ownership does not match the request',
      },
    });
    await expect(stateStore.getApproval(approval.id)).resolves.toMatchObject({
      status: 'pending',
    });

    const wrongSession = await app.fetch(
      request(`/control/approvals/${approval.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          turn_id: turn.id,
          bridge_session_id: other.session.bridgeSessionId,
          decision: { type: 'allow', scope: 'once' },
        }),
      }),
    );

    expect(wrongSession.status).toBe(409);
    await expect(wrongSession.json()).resolves.toEqual({
      error: {
        code: 'approval_scope_mismatch',
        message: 'Approval ownership does not match the request',
      },
    });
    await expect(stateStore.getApproval(approval.id)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  test('returns terminal approval decisions idempotently without mutating them', async () => {
    const stateStore = createStateStore();
    const { session, turn, approval } = await createApprovalFixture(stateStore);
    const app = createDurableApp(stateStore);
    const resolvePath = `/control/approvals/${approval.id}/resolve`;

    const first = await app.fetch(
      request(resolvePath, {
        method: 'POST',
        body: JSON.stringify({
          turn_id: turn.id,
          bridge_session_id: session.bridgeSessionId,
          decision: { type: 'deny', scope: 'once', reason: 'manual' },
        }),
      }),
    );
    const eventCountAfterFirst = stateStore.database
      .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM events WHERE turn_id = ?')
      .get(turn.id);
    const second = await app.fetch(
      request(resolvePath, {
        method: 'POST',
        body: JSON.stringify({
          turn_id: turn.id,
          bridge_session_id: session.bridgeSessionId,
          decision: { type: 'allow', scope: 'once' },
        }),
      }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      approval_id: approval.id,
      turn_id: turn.id,
      bridge_session_id: session.bridgeSessionId,
      status: 'already_terminal',
      decision: { type: 'deny', scope: 'once', reason: 'manual' },
    });
    await expect(stateStore.getApproval(approval.id)).resolves.toMatchObject({
      status: 'denied',
      decision: { type: 'deny', scope: 'once', reason: 'manual' },
    });
    expect(
      stateStore.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM events WHERE turn_id = ?',
        )
        .get(turn.id),
    ).toEqual(eventCountAfterFirst);
  });

  test('uses non-OpenAI error bodies for approval control endpoint failures', async () => {
    const stateStore = createStateStore();
    const { session, turn, approval } = await createApprovalFixture(stateStore);
    const app = createDurableApp(stateStore);

    const response = await app.fetch(
      request(`/control/approvals/${approval.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          turn_id: turn.id,
          bridge_session_id: session.bridgeSessionId,
          decision: { type: 'timeout', reason: 'client_requested' },
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'invalid_request',
        message: 'Approval decision type must be allow or deny',
      },
    });
    expect(JSON.stringify(body)).not.toContain('rate_limit_error');
    expect(JSON.stringify(body)).not.toContain('invalid_request_error');
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

  test('serves a versioned non-secret capabilities projection', async () => {
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
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
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
      acp: {
        native_cancel: {
          classification: 'native-terminal-only',
          support: 'unsupported',
          source: 'probe',
        },
      },
      security: {
        bearer_auth: true,
        cors_mode: 'disabled',
        loopback_only: true,
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('0123456789abcdef');
    expect(serialized).not.toContain('/tmp/secret-workspace');
    expect(serialized).not.toContain(config.projectlessWorkspaceRoot);
    expect(serialized).not.toContain(config.stateDatabasePath);
    expect(serialized).not.toContain(config.host);
  });

  test('requires auth for capabilities and uses Volare error envelope', async () => {
    const app = createApp({ config });

    const response = await app.fetch(new Request('http://127.0.0.1:8000/capabilities'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'unauthorized',
        message: 'Missing or invalid bearer token',
      },
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
    const app = createApp({
      config,
      healthStatus: () => 'recovering',
      workerMetrics: () => ({
        acp_workers_active: 1,
        acp_workers_creating: 0,
        acp_workers_idle: 1,
        acp_admission_queue_depth: 2,
      }),
    });

    const health = await app.fetch(request('/healthz'));
    const metrics = await app.fetch(request('/metrics'));

    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toEqual({ status: 'recovering' });
    expect(metrics.status).toBe(200);
    await expect(metrics.json()).resolves.toMatchObject({
      status: 'recovering',
      requests_total: 2,
      turns_total: 0,
      turns_with_zero_tools_total: 0,
      turns_with_sources_total: 0,
      turns_with_citation_like_output_total: 0,
      turns_with_grounding_warnings_total: 0,
      turns_unmediated_total: 0,
      acp_workers_active: 1,
      acp_workers_creating: 0,
      acp_workers_idle: 1,
      acp_admission_queue_depth: 2,
    });
  });

  test('updates aggregate turn metrics only for accepted live turns and terminal events', async () => {
    const app = createInMemoryApp();
    const before = await app.fetch(request('/metrics'));
    await expect(before.json()).resolves.toMatchObject({
      turns_total: 0,
      turns_with_zero_tools_total: 0,
      turns_with_sources_total: 0,
      turns_with_citation_like_output_total: 0,
      turns_with_grounding_warnings_total: 0,
      turns_unmediated_total: 0,
    });

    const malformed = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);
    const afterRejected = await app.fetch(request('/metrics'));
    await expect(afterRejected.json()).resolves.toMatchObject({
      turns_total: 0,
      turns_with_zero_tools_total: 0,
      turns_with_citation_like_output_total: 0,
    });

    const created = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'see https://example.com/report [1]',
        }),
      }),
    );
    expect(created.status).toBe(200);
    const streamText = await created.text();
    const responseId = /"id":"(resp_[^"]+)"/.exec(streamText)?.[1];
    expect(responseId).toBeDefined();

    const afterLiveTurn = await app.fetch(request('/metrics'));
    const metrics = (await afterLiveTurn.json()) as Record<string, unknown>;
    expect(metrics).toMatchObject({
      turns_total: 1,
      turns_with_zero_tools_total: 1,
      turns_with_sources_total: 0,
      turns_with_citation_like_output_total: 1,
      turns_with_grounding_warnings_total: 1,
      turns_unmediated_total: 0,
    });
    expect(Object.keys(metrics).filter((key) => key.startsWith('turns_by_'))).toEqual([]);
    expect(Object.keys(metrics).filter((key) => key.includes('warning_code'))).toEqual([]);
    expect(Object.keys(metrics).filter((key) => key.includes('source_url'))).toEqual([]);

    const stored = await app.fetch(request(`/openai/v1/responses/${responseId}`));
    expect(stored.status).toBe(200);
    const afterReplay = await app.fetch(request('/metrics'));
    await expect(afterReplay.json()).resolves.toMatchObject({
      turns_total: 1,
      turns_with_zero_tools_total: 1,
      turns_with_citation_like_output_total: 1,
      turns_with_grounding_warnings_total: 1,
    });
  });

  test('emits one turn audit per accepted live turn without replay or content leakage', async () => {
    const logger = new CapturingLogger();
    const app = createInMemoryApp({ logger });

    const malformed = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(logger.entries.filter((entry) => entry.fields['event'] === 'turn.audit')).toHaveLength(
      0,
    );

    const createResponse = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'do not leak this prompt',
        }),
      }),
    );
    const streamText = await createResponse.text();
    const responseId = /"id":"(resp_[^"]+)"/.exec(streamText)?.[1];
    expect(responseId).toBeDefined();

    const audits = logger.entries.filter((entry) => entry.fields['event'] === 'turn.audit');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      level: 'info',
      message: 'turn audit',
      fields: {
        copilotMcpMode: 'disabled',
        copilotPermissionMode: 'full',
        unmediatedToolingEnabled: false,
      },
    });
    expect(typeof audits[0]?.fields['sessionId']).toBe('string');
    expect(JSON.stringify(audits)).not.toContain('do not leak this prompt');
    expect(JSON.stringify(audits)).not.toContain(process.cwd());

    const stored = await app.fetch(request(`/openai/v1/responses/${responseId}`));
    expect(stored.status).toBe(200);
    expect(logger.entries.filter((entry) => entry.fields['event'] === 'turn.audit')).toHaveLength(
      1,
    );
  });

  test('emits turn audit before backend execution can begin', async () => {
    const logger = new CapturingLogger();
    const backend = new AuditOrderingBackend(logger);
    const app = createInMemoryApp({ config: unmediatedConfig, logger }, backend);

    const response = await app.fetch(
      request('/openai/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'copilot-agent',
          input: 'search current docs',
        }),
      }),
    );
    await response.text();

    const auditIndex = logger.entries.findIndex((entry) => entry.fields['event'] === 'turn.audit');
    const backendIndex = logger.entries.findIndex(
      (entry) => entry.fields['event'] === 'test.backend.send.entered',
    );
    expect(backend.sawAuditBeforeSend).toBe(true);
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(backendIndex).toBeGreaterThan(auditIndex);
  });

  test('counts unmediated turns separately without counting them as content-grounding warnings', async () => {
    const logger = new CapturingLogger();
    const app = createInMemoryApp({ config: unmediatedConfig, logger });

    const responses = await Promise.all([
      app.fetch(
        request('/openai/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ model: 'copilot-agent', input: 'first [1]' }),
        }),
      ),
      app.fetch(
        request('/openai/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ model: 'copilot-agent', input: 'second' }),
        }),
      ),
    ]);
    const streamTexts = await Promise.all(responses.map((response) => response.text()));

    const metrics = (await (await app.fetch(request('/metrics'))).json()) as Record<
      string,
      unknown
    >;
    expect(metrics).toMatchObject({
      turns_total: 2,
      turns_unmediated_total: 2,
      turns_with_citation_like_output_total: 1,
      turns_with_grounding_warnings_total: 1,
    });
    const audits = logger.entries.filter((entry) => entry.fields['event'] === 'turn.audit');
    expect(audits).toHaveLength(2);
    expect(audits.every((entry) => entry.level === 'warn')).toBe(true);
    expect(audits.map((entry) => entry.fields['unmediatedToolingEnabled'])).toEqual([true, true]);
    const encoded = streamTexts.join('\n');
    for (const field of [
      'copilotMcpMode',
      'copilotPermissionMode',
      'unmediatedToolingEnabled',
      'sessionId',
    ]) {
      expect(encoded).not.toContain(field);
    }
  });

  test('counts concurrent live turns and tool-observed turns without prompt-derived metric keys', async () => {
    const app = createInMemoryApp({}, new ToolObservedBackend());

    const responses = await Promise.all([
      app.fetch(
        request('/openai/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ model: 'copilot-agent', input: 'first [1]' }),
        }),
      ),
      app.fetch(
        request('/openai/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ model: 'copilot-agent', input: 'second' }),
        }),
      ),
    ]);
    await Promise.all(responses.map((response) => response.text()));

    const metrics = (await (await app.fetch(request('/metrics'))).json()) as Record<
      string,
      unknown
    >;
    expect(metrics).toMatchObject({
      turns_total: 2,
      turns_with_zero_tools_total: 0,
      turns_with_citation_like_output_total: 1,
      turns_with_grounding_warnings_total: 1,
      turns_unmediated_total: 0,
    });
    expect(
      Object.keys(metrics).some((key) => key.includes('first') || key.includes('second')),
    ).toBe(false);
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

  test('keeps client disconnect classification when cancellation cleanup fails', async () => {
    const logger = new CapturingLogger();
    const workspace: IWorkspace = {
      id: 'workspace_test',
      rootPath: process.cwd(),
    };
    const app = createInMemoryApp({
      disconnectGraceMs: 0,
      logger,
      sessionManager: new CancelCleanupFailingSessionManager({
        backend: new MockBackend(),
        workspace,
      }),
    });
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

    await expect(reader?.cancel()).rejects.toThrow('cancel cleanup failed');

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'responses stream interrupted',
        fields: expect.objectContaining({
          event: 'responses.stream.interrupted',
          interruptionReason: 'client_disconnect',
          interruptionPhase: 'pre_terminal',
          cleanupErrorCode: 'internal_error',
        }),
      }),
    );
    expect(
      logger.entries.some((entry) => entry.fields['event'] === 'responses.stream.failed'),
    ).toBe(false);
    expect(JSON.stringify(logger.entries)).not.toContain('cancel cleanup failed');
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
    const logger = new CapturingLogger();
    const app = createDurableApp(stateStore, {
      config: unmediatedConfig,
      eventJournal,
      logger,
    });

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
    for (const field of [
      'copilotMcpMode',
      'copilotPermissionMode',
      'unmediatedToolingEnabled',
      'sessionId',
    ]) {
      expect(JSON.stringify(debugBody)).not.toContain(field);
    }

    const auditCount = logger.entries.filter(
      (entry) => entry.fields['event'] === 'turn.audit',
    ).length;
    const stored = await app.fetch(request(`/openai/v1/responses/${responseId}`));
    expect(stored.status).toBe(200);
    expect(logger.entries.filter((entry) => entry.fields['event'] === 'turn.audit')).toHaveLength(
      auditCount,
    );
  });

  test('strips reserved Volare metadata before SSE, journal, and stored replay', async () => {
    const stateStore = createStateStore();
    const eventJournal = new SQLiteEventJournal(stateStore.database);
    const logger = new CapturingLogger();
    const app = createDurableApp(stateStore, { eventJournal, logger });

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

    expect(streamText).toContain('"metadata":{"keep":"safe","nested":{}}');
    expect(streamText).not.toContain('volare.sources');
    expect(streamText).not.toContain('source-secret');
    expect(clientRef).toBeDefined();

    const debugResponse = await app.fetch(request(`/debug/turns/${clientRef?.turnId}/events`));
    const debugText = await debugResponse.text();
    expect(debugText).toContain('"requestMetadata":{"keep":"safe","nested":{}}');
    expect(debugText).not.toContain('volare.sources');
    expect(debugText).not.toContain('nested-secret');

    const stored = await app.fetch(request(`/openai/v1/responses/${responseId}`));
    const storedText = await stored.text();
    expect(storedText).toContain('"metadata":{"keep":"safe","nested":{}}');
    expect(storedText).not.toContain('volare.sources');
    expect(storedText).not.toContain('source-secret');
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'reserved Volare metadata stripped',
        fields: expect.objectContaining({
          event: 'responses.metadata.reserved_keys_stripped',
          keyPaths: ['metadata.volare.sources', 'metadata.nested.VOLARE'],
        }),
      }),
    );

    const internalTurnGet = await app.fetch(request(`/openai/v1/responses/${clientRef?.turnId}`));
    expect(internalTurnGet.status).toBe(404);
    const internalTurnCancel = await app.fetch(
      request(`/openai/v1/responses/${clientRef?.turnId}/cancel`, { method: 'POST' }),
    );
    expect(internalTurnCancel.status).toBe(404);
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

    const cancelResponse = await restartedApp.fetch(
      request(`/openai/v1/responses/${responseId}/cancel`, { method: 'POST' }),
    );
    expect(cancelResponse.status).toBe(200);
    await expect(cancelResponse.json()).resolves.toMatchObject({
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
    expect(() => createServerRuntimeConfig({ VOLARE_COPILOT_MCP_MODE: 'auto' })).toThrow(
      'VOLARE_COPILOT_MCP_MODE must be disabled or unmediated',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_COPILOT_RUNTIME_MODE: 'auto' })).toThrow(
      'VOLARE_COPILOT_RUNTIME_MODE must be process or acp',
    );
    expect(() => createServerRuntimeConfig({ VOLARE_COPILOT_ACP_MAX_WORKERS: '0' })).toThrow(
      'VOLARE_COPILOT_ACP_MAX_WORKERS must be an integer',
    );
    expect(() =>
      createServerRuntimeConfig({ VOLARE_COPILOT_ACP_CANCEL_STRATEGY: 'graceful' }),
    ).toThrow('VOLARE_COPILOT_ACP_CANCEL_STRATEGY must be kill, native, or auto');
    expect(() =>
      createServerRuntimeConfig({ VOLARE_COPILOT_ACP_NATIVE_CANCEL_WAIT_MS: '0' }),
    ).toThrow('VOLARE_COPILOT_ACP_NATIVE_CANCEL_WAIT_MS must be an integer');
    expect(() =>
      createServerRuntimeConfig({ VOLARE_COPILOT_ACP_ADMISSION_TIMEOUT_MS: '-1' }),
    ).toThrow('VOLARE_COPILOT_ACP_ADMISSION_TIMEOUT_MS must be an integer');
    expect(() =>
      createServerRuntimeConfig({
        VOLARE_COPILOT_MCP_MODE: 'unmediated',
        VOLARE_COPILOT_PERMISSION_MODE: 'restricted',
      }),
    ).toThrow(
      'VOLARE_COPILOT_MCP_MODE=unmediated requires VOLARE_COPILOT_PERMISSION_MODE to be web or full',
    );
    expect(() =>
      createServerRuntimeConfig({
        VOLARE_COPILOT_RUNTIME_MODE: 'acp',
        VOLARE_COPILOT_MCP_MODE: 'unmediated',
        VOLARE_COPILOT_PERMISSION_MODE: 'full',
      }),
    ).toThrow(
      'VOLARE_COPILOT_RUNTIME_MODE=acp does not support VOLARE_COPILOT_MCP_MODE=unmediated',
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
        VOLARE_COPILOT_RUNTIME_MODE: 'process',
        VOLARE_COPILOT_ACP_MAX_WORKERS: '8',
        VOLARE_COPILOT_ACP_ADMISSION_TIMEOUT_MS: '2500',
        VOLARE_COPILOT_ACP_CANCEL_STRATEGY: 'native',
        VOLARE_COPILOT_ACP_NATIVE_CANCEL_WAIT_MS: '5000',
        VOLARE_COPILOT_PERMISSION_MODE: 'full',
        VOLARE_COPILOT_MCP_MODE: 'unmediated',
        SSL_CERT_FILE: '/tmp/cacert.pem',
        REQUESTS_CA_BUNDLE: '/tmp/cacert.pem',
        CURL_CA_BUNDLE: '/tmp/cacert.pem',
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
      copilotRuntimeMode: 'process',
      copilotAcpMaxWorkers: 8,
      copilotAcpAdmissionTimeoutMs: 2500,
      copilotAcpCancelStrategy: 'native',
      copilotAcpNativeCancelWaitMs: 5000,
      copilotPermissionMode: 'full',
      copilotMcpMode: 'unmediated',
      childProcessEnv: {
        SSL_CERT_FILE: '/tmp/cacert.pem',
        REQUESTS_CA_BUNDLE: '/tmp/cacert.pem',
        CURL_CA_BUNDLE: '/tmp/cacert.pem',
      },
    });
    expect(createServerRuntimeConfig({}).copilotRuntimeMode).toBe('process');
    expect(createServerRuntimeConfig({}).copilotAcpMaxWorkers).toBe(10);
    expect(createServerRuntimeConfig({}).copilotAcpAdmissionTimeoutMs).toBe(30_000);
    expect(createServerRuntimeConfig({}).copilotAcpCancelStrategy).toBe('kill');
    expect(createServerRuntimeConfig({}).copilotAcpNativeCancelWaitMs).toBe(5000);
    expect(
      createServerRuntimeConfig({
        VOLARE_COPILOT_RUNTIME_MODE: 'acp',
        VOLARE_COPILOT_ACP_MAX_WORKERS: '20',
        VOLARE_MAX_ACTIVE_SESSIONS: '3',
      }),
    ).toMatchObject({
      copilotRuntimeMode: 'acp',
      copilotAcpMaxWorkers: 3,
      maxActiveSessions: 3,
    });
    expect(createServerRuntimeConfig({}).copilotPermissionMode).toBe('full');
    expect(createServerRuntimeConfig({}).copilotMcpMode).toBe('disabled');
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
