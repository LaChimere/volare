import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureCodex } from '../../scripts/config-codex';
import { DurableSessionManager } from '../../src/core/durable-session-manager';
import { InMemorySessionManager } from '../../src/core/in-memory-session-manager';
import type {
  AgentEvent,
  IAgentBackend,
  IAgentRequest,
  IBackendCapabilities,
  IBackendSession,
  ICancelOptions,
  ICancelResult,
  ICreateSessionOptions,
  IWorkspace,
  IWorkspaceHints,
  IWorkspaceResolver,
} from '../../src/core/types';
import { SQLiteEventJournal } from '../../src/events/sqlite-event-journal';
import { createApp } from '../../src/server/app';
import { createServerRuntimeConfig } from '../../src/server/config';
import { migrate } from '../../src/state/migrations';
import { SQLiteStateStore } from '../../src/state/sqlite-store';
import { MockBackend } from '../support/backends/mock-backend';

const apiKey = '0123456789abcdef';
const explicitWorkspaceRoot = process.cwd();
const projectlessWorkspaceRoot = join(tmpdir(), 'volare-it-projectless-workspace');

const config = createServerRuntimeConfig({
  VOLARE_API_KEY: apiKey,
  VOLARE_WORKSPACE_ROOT: explicitWorkspaceRoot,
  VOLARE_ALLOWED_WORKSPACE_ROOTS: explicitWorkspaceRoot,
  VOLARE_PROJECTLESS_WORKSPACE_ROOT: projectlessWorkspaceRoot,
});

const servers: Array<ReturnType<typeof Bun.serve>> = [];

interface ISseEvent {
  type?: unknown;
  response?: unknown;
  delta?: unknown;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe('Codex CLI provider integration', () => {
  test('writes Codex CLI provider config while preserving unrelated settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-codex-cli-config-'));
    const configPath = join(root, 'config.toml');
    await writeFile(
      configPath,
      [
        'profile = "other"',
        'model_provider = "other"',
        'model = "other-model"',
        '',
        '[model_providers.other]',
        'name = "Other"',
        'base_url = "https://example.test/v1"',
      ].join('\n'),
    );

    try {
      const result = await configureCodex({
        configPath,
        baseUrl: 'http://127.0.0.1:8765/openai/v1',
        envKey: 'VOLARE_API_KEY',
        backupSuffix: 'it',
      });

      expect(result).toMatchObject({
        configPath,
        changed: true,
        backupPath: `${configPath}.volare-backup-it`,
      });
      await expect(readFile(`${configPath}.volare-backup-it`, 'utf8')).resolves.toContain(
        '[model_providers.other]',
      );
      await expect(readFile(configPath, 'utf8')).resolves.toContain(
        '[model_providers.volare]\nname = "Volare"\nbase_url = "http://127.0.0.1:8765/openai/v1"\nwire_api = "responses"\nenv_key = "VOLARE_API_KEY"\nrequires_openai_auth = true',
      );
      await expect(readFile(configPath, 'utf8')).resolves.toContain(
        '[profiles.volare]\nmodel_provider = "volare"\nmodel = "copilot-agent"',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('serves authenticated health, metrics, and Codex model catalog routes', async () => {
    const server = startServer(createInMemoryApp());

    const unauthenticated = await fetch(`${server.baseUrl}/openai/v1/models`);
    const health = await fetch(`${server.baseUrl}/healthz`, { headers: authHeaders() });
    const metrics = await fetch(`${server.baseUrl}/metrics`, { headers: authHeaders() });
    const models = await fetch(`${server.baseUrl}/openai/v1/models?client_version=it`, {
      headers: authHeaders(),
    });

    expect(unauthenticated.status).toBe(401);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ready' });
    expect(metrics.status).toBe(200);
    await expect(metrics.json()).resolves.toMatchObject({ status: 'ready' });
    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toMatchObject({
      models: [
        {
          slug: 'copilot-agent',
          supported_in_api: true,
          supported_reasoning_levels: [],
          support_verbosity: false,
          input_modalities: ['text'],
        },
      ],
    });
  });

  test('routes projectless and explicit workspace requests through workspace hints', async () => {
    const resolver = new CapturingWorkspaceResolver();
    const server = startServer(createInMemoryApp({ workspaceResolver: resolver }));

    const projectless = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'projectless request',
      stream: true,
    });
    const explicit = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'explicit workspace request',
      stream: true,
      metadata: { workspace_root: explicitWorkspaceRoot },
    });

    expect(projectless.status).toBe(200);
    expect(explicit.status).toBe(200);
    expect(resolver.hints).toEqual([
      { source: 'process-cwd' },
      { source: 'client-metadata', requestedRoot: explicitWorkspaceRoot },
    ]);
  });

  test('streams a Codex CLI Responses request and stores a retrievable snapshot', async () => {
    const resolver = new CapturingWorkspaceResolver();
    const server = startServer(createInMemoryApp({ workspaceResolver: resolver }));

    const response = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      stream: true,
      instructions: 'Answer briefly.',
      reasoning: { effort: 'medium', summary: 'auto' },
      text: { verbosity: 'high' },
      metadata: {
        workspace_root: explicitWorkspaceRoot,
        request_source: 'metadata',
      },
      client_metadata: {
        workspace_root: '/tmp/client-metadata-should-not-win',
        client: 'codex-cli',
      },
      tools: [{ type: 'function', name: 'read_project' }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Project context.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'What is the project status?' }] },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    const events = parseSseEvents(await response.text());
    const responseId = responseIdFromEvents(events);
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.some((event) => event.delta === 'What is the project status?')).toBe(true);
    expect(resolver.hints).toEqual([
      { source: 'client-metadata', requestedRoot: explicitWorkspaceRoot },
    ]);

    const stored = await fetch(`${server.baseUrl}/openai/v1/responses/${responseId}`, {
      headers: authHeaders(),
    });

    expect(stored.status).toBe(200);
    await expect(stored.json()).resolves.toMatchObject({
      id: responseId,
      status: 'completed',
      metadata: {
        workspace_root: explicitWorkspaceRoot,
        request_source: 'metadata',
        client: 'codex-cli',
      },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'What is the project status?' }],
        },
      ],
    });
  });

  test('preserves latest-turn attachment summaries without leaking previous message attachments', async () => {
    const backend = new CapturingBackend();
    const server = startServer(createInMemoryApp({ backend }));

    const response = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      stream: true,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Earlier request' },
            { type: 'input_image', image_url: 'data:image/png;base64,OLD' },
          ],
        },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer' }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Current request' },
            { type: 'input_file', filename: 'notes.txt', file_id: 'file_current' },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]?.input).toMatchObject({
      message: 'Current request',
      conversationHistory: [
        { role: 'user', content: 'Earlier request' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
      attachments: [
        {
          kind: 'file',
          name: 'notes.txt',
          uri: 'file_current',
          metadata: { file_id: 'file_current' },
        },
      ],
    });
  });

  test('continues a Codex CLI conversation through durable previous_response_id', async () => {
    const durable = createDurableServer();
    const server = startServer(durable.app);

    const first = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'first turn',
      stream: true,
    });
    const firstId = responseIdFromEvents(parseSseEvents(await first.text()));

    const second = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'second turn',
      stream: true,
      previous_response_id: firstId,
    });
    const secondEvents = parseSseEvents(await second.text());
    const secondId = responseIdFromEvents(secondEvents);
    const firstRef = await durable.stateStore.resolveClientRef('openai-responses-v1', firstId);
    const secondRef = await durable.stateStore.resolveClientRef('openai-responses-v1', secondId);

    expect(second.status).toBe(200);
    expect(firstRef).toBeDefined();
    expect(secondRef).toMatchObject({
      threadId: firstRef?.threadId,
      parentExternalId: firstId,
    });

    const storedSecond = await fetch(`${server.baseUrl}/openai/v1/responses/${secondId}`, {
      headers: authHeaders(),
    });

    expect(storedSecond.status).toBe(200);
    await expect(storedSecond.json()).resolves.toMatchObject({
      id: secondId,
      previous_response_id: firstId,
      status: 'completed',
      output: [{ content: [{ text: 'second turn' }] }],
    });
  });

  test('serves stored durable responses and debug events after app restart', async () => {
    const durable = createDurableServer();
    const server = startServer(durable.app);

    const created = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'journal replay',
      stream: true,
    });
    const responseId = responseIdFromEvents(parseSseEvents(await created.text()));
    const ref = await durable.stateStore.resolveClientRef('openai-responses-v1', responseId);
    expect(ref).toBeDefined();

    const restarted = startServer(
      createDurableApp(durable.stateStore, durable.eventJournal, new MockBackend()),
    );
    const stored = await fetch(`${restarted.baseUrl}/openai/v1/responses/${responseId}`, {
      headers: authHeaders(),
    });
    const debug = await fetch(`${restarted.baseUrl}/debug/turns/${ref?.turnId}/events`, {
      headers: authHeaders(),
    });

    expect(stored.status).toBe(200);
    await expect(stored.json()).resolves.toMatchObject({
      id: responseId,
      status: 'completed',
      output: [{ content: [{ text: 'journal replay' }] }],
    });
    expect(debug.status).toBe(200);
    const debugBody = (await debug.json()) as {
      events: Array<{ canonicalJson?: { type?: string } }>;
    };
    expect(debugBody.events.map((event) => event.canonicalJson?.type)).toEqual([
      'turn.created',
      'text.delta',
      'turn.succeeded',
    ]);
  });

  test('cancels an in-progress response and handles client stream disconnects', async () => {
    const cancelBackend = new BlockingBackend();
    const cancelServer = startServer(
      createInMemoryApp({ backend: cancelBackend, disconnectGraceMs: 0 }),
    );

    const created = await postJson(cancelServer.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'cancel this turn',
      stream: true,
    });
    const reader = created.body?.getReader();
    const firstChunk = await reader?.read();
    const responseId = responseIdFromEvents(parseSseEvents(decode(firstChunk?.value)));
    const cancel = await fetch(`${cancelServer.baseUrl}/openai/v1/responses/${responseId}/cancel`, {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(cancel.status).toBe(200);
    await expect(cancel.json()).resolves.toMatchObject({
      id: responseId,
      status: 'incomplete',
    });
    await reader?.cancel();

    const disconnectBackend = new BlockingBackend();
    const disconnectServer = startServer(
      createInMemoryApp({ backend: disconnectBackend, disconnectGraceMs: 0 }),
    );
    const disconnectController = new AbortController();
    const disconnectResponse = await postJson(
      disconnectServer.baseUrl,
      '/openai/v1/responses',
      {
        model: 'copilot-agent',
        input: 'disconnect this turn',
        stream: true,
      },
      { signal: disconnectController.signal },
    );
    const disconnectReader = disconnectResponse.body?.getReader();
    const disconnectChunk = await disconnectReader?.read();
    const disconnectId = responseIdFromEvents(parseSseEvents(decode(disconnectChunk?.value)));

    disconnectController.abort();
    await disconnectReader?.cancel().catch(() => undefined);
    const stored = await waitForStoredStatus(disconnectServer.baseUrl, disconnectId, 'incomplete');

    expect(stored.status).toBe(200);
    await expect(stored.json()).resolves.toMatchObject({
      id: disconnectId,
      status: 'incomplete',
    });
  });

  test('returns explicit errors for Codex CLI boundary failures', async () => {
    const durable = createDurableServer();
    const server = startServer(durable.app);

    const malformed = await fetch(`${server.baseUrl}/openai/v1/responses`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{',
    });
    const badTools = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'hello',
      tools: { type: 'function' },
    });
    const nonStreaming = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'hello',
      stream: false,
    });
    const missingParent = await postJson(server.baseUrl, '/openai/v1/responses', {
      model: 'copilot-agent',
      input: 'second turn',
      previous_response_id: 'resp_missing',
    });
    const cors = await fetch(`${server.baseUrl}/openai/v1/models`, {
      headers: { ...authHeaders(), origin: 'https://example.test' },
    });

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: { type: 'invalid_request', message: 'Malformed JSON body' },
    });
    expect(badTools.status).toBe(400);
    await expect(badTools.json()).resolves.toEqual({
      error: { type: 'invalid_request', message: 'Responses request tools must be an array' },
    });
    expect(nonStreaming.status).toBe(400);
    await expect(nonStreaming.json()).resolves.toEqual({
      error: {
        type: 'unsupported_parameter',
        message: 'Responses request stream=false is not supported; Volare streams every response',
      },
    });
    expect(missingParent.status).toBe(404);
    await expect(missingParent.json()).resolves.toEqual({
      error: { type: 'not_found', message: 'previous_response_id was not found' },
    });
    expect(cors.status).toBe(403);
    await expect(cors.json()).resolves.toEqual({
      error: { type: 'workspace_forbidden', message: 'Unexpected Origin header' },
    });
  });
});

class CapturingWorkspaceResolver implements IWorkspaceResolver {
  readonly hints: IWorkspaceHints[] = [];

  async resolve(hints: IWorkspaceHints) {
    this.hints.push(hints);
    return {
      id: 'workspace_integration',
      rootPath: explicitWorkspaceRoot,
    };
  }
}

class CapturingBackend extends MockBackend {
  readonly requests: IAgentRequest[] = [];

  override async *send(
    session: IBackendSession,
    request: IAgentRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    yield* super.send(session, request, signal);
  }
}

class BlockingBackend implements IAgentBackend {
  readonly name = 'blocking';

  capabilities(): IBackendCapabilities {
    return {
      persistentSessions: false,
      serverSideTools: false,
      permissionRequests: false,
      externalApprovalDecisions: false,
      backendInternalPauseResume: false,
      cancellation: true,
    };
  }

  async createSession(
    workspace: IWorkspace,
    options: ICreateSessionOptions,
  ): Promise<IBackendSession> {
    return {
      bridgeSessionId: options.bridgeSessionId,
      backendSessionId: `blocking_${options.bridgeSessionId}`,
      workspaceId: workspace.id,
      threadId: options.threadId,
      status: 'active',
    };
  }

  async resumeSession(session: IBackendSession): Promise<IBackendSession> {
    return session;
  }

  async *send(
    _session: IBackendSession,
    request: IAgentRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    yield { type: 'text.delta', turnId: request.turnId, delta: 'pending' };
    while (!signal?.aborted) {
      await Bun.sleep(5);
    }
    yield { type: 'turn.cancelled', turnId: request.turnId };
  }

  async cancel(_session: IBackendSession, _options?: ICancelOptions): Promise<ICancelResult> {
    return { status: 'cancelled' };
  }

  async disposeSession(_session: IBackendSession): Promise<void> {}
}

function createInMemoryApp(
  options: {
    backend?: IAgentBackend;
    workspaceResolver?: IWorkspaceResolver;
    disconnectGraceMs?: number;
  } = {},
) {
  const workspace: IWorkspace = {
    id: 'workspace_integration',
    rootPath: explicitWorkspaceRoot,
  };
  return createApp({
    config,
    workspaceResolver: options.workspaceResolver ?? new CapturingWorkspaceResolver(),
    sessionManager: new InMemorySessionManager({
      backend: options.backend ?? new MockBackend(),
      workspace,
    }),
    ...(options.disconnectGraceMs === undefined
      ? {}
      : { disconnectGraceMs: options.disconnectGraceMs }),
  });
}

function createDurableServer(): {
  app: ReturnType<typeof createApp>;
  stateStore: SQLiteStateStore;
  eventJournal: SQLiteEventJournal;
} {
  const database = new Database(':memory:');
  migrate(database);
  const stateStore = new SQLiteStateStore(database);
  const eventJournal = new SQLiteEventJournal(database);
  return {
    app: createDurableApp(stateStore, eventJournal, new MockBackend({ persistentSessions: true })),
    stateStore,
    eventJournal,
  };
}

function createDurableApp(
  stateStore: SQLiteStateStore,
  eventJournal: SQLiteEventJournal,
  backend: IAgentBackend,
) {
  return createApp({
    config,
    stateStore,
    eventJournal,
    sessionManager: new DurableSessionManager({
      store: stateStore,
      backend,
      cancelTimeoutMs: config.cancelTimeoutMs,
    }),
  });
}

function startServer(app: ReturnType<typeof createApp>): { baseUrl: string } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: app.fetch,
  });
  servers.push(server);
  return { baseUrl: `http://${server.hostname}:${server.port}` };
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
  };
}

function jsonHeaders(): Record<string, string> {
  return {
    ...authHeaders(),
    'content-type': 'application/json',
  };
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  init: Pick<RequestInit, 'signal'> = {},
): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    ...init,
  });
}

function parseSseEvents(streamText: string): ISseEvent[] {
  return streamText.split('\n\n').flatMap((block) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    return data && data !== '[DONE]' ? [JSON.parse(data) as ISseEvent] : [];
  });
}

function responseIdFromEvents(events: ISseEvent[]): string {
  for (const event of events) {
    const id = stringIdFromRecord(event.response);
    if (id) {
      return id;
    }
  }
  throw new Error('SSE events did not include a response id');
}

async function waitForStoredStatus(
  baseUrl: string,
  responseId: string,
  status: string,
): Promise<Response> {
  let latest: Response | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await fetch(`${baseUrl}/openai/v1/responses/${responseId}`, {
      headers: authHeaders(),
    });
    const body = (await latest.clone().json()) as { status?: unknown };
    if (body.status === status) {
      return latest;
    }
    await Bun.sleep(10);
  }
  return (
    latest ?? fetch(`${baseUrl}/openai/v1/responses/${responseId}`, { headers: authHeaders() })
  );
}

function stringIdFromRecord(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decode(value: Uint8Array | undefined): string {
  return value ? new TextDecoder().decode(value) : '';
}
