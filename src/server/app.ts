import { DefaultApprovalPolicy } from '../approvals/policy';
import { ApprovalProvider } from '../approvals/provider';
import { MockBackend } from '../backends/mock/backend';
import { DurableSessionManager } from '../core/durable-session-manager';
import { AgentLoomError } from '../core/errors';
import { InMemorySessionManager } from '../core/in-memory-session-manager';
import type {
  AgentEvent,
  EventJournalInterface,
  SessionManagerInterface,
  StateStoreInterface,
} from '../core/types';
import { WorkspaceResolver } from '../core/workspace-resolver';
import { encodeOpenAIError, OpenAIResponsesAdapter } from '../northbound/openai-responses/adapter';
import { requireBearerAuth } from './auth';
import type { ServerRuntimeConfigInterface } from './config';

export interface AppDependenciesInterface {
  config: ServerRuntimeConfigInterface;
  adapter?: OpenAIResponsesAdapter;
  workspaceResolver?: WorkspaceResolver;
  sessionManager?: SessionManagerInterface;
  stateStore?: StateStoreInterface;
  eventJournal?: EventJournalInterface;
  disconnectGraceMs?: number;
  healthStatus?: () => 'recovering' | 'ready';
}

export function createApp(dependencies: AppDependenciesInterface): {
  fetch(request: Request): Promise<Response>;
} {
  const stateStore = dependencies.stateStore;
  const adapter = dependencies.adapter ?? new OpenAIResponsesAdapter(stateStore);
  const workspaceResolver = dependencies.workspaceResolver ?? new WorkspaceResolver();
  const startedAt = Date.now();
  let requestsTotal = 0;
  let sessionManager =
    dependencies.sessionManager ??
    (stateStore
      ? new DurableSessionManager({
          store: stateStore,
          backend: new MockBackend(),
          approvalProvider: new ApprovalProvider({
            store: stateStore,
            policy: new DefaultApprovalPolicy({ timeoutMs: dependencies.config.approvalTimeoutMs }),
          }),
          cancelTimeoutMs: dependencies.config.cancelTimeoutMs,
        })
      : undefined);

  return {
    async fetch(request: Request): Promise<Response> {
      requestsTotal += 1;
      try {
        requireBearerAuth(request, dependencies.config.apiKey);
        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname === '/healthz') {
          const status = dependencies.healthStatus?.() ?? 'ready';
          return Response.json(
            {
              status,
            },
            { status: status === 'ready' ? 200 : 503 },
          );
        }

        if (request.method === 'GET' && url.pathname === '/metrics') {
          return Response.json({
            status: dependencies.healthStatus?.() ?? 'ready',
            uptime_ms: Date.now() - startedAt,
            requests_total: requestsTotal,
          });
        }

        if (request.method === 'GET' && url.pathname === '/openai/v1/models') {
          return Response.json({
            models: [{ id: 'copilot-agent', object: 'model', owned_by: 'github' }],
          });
        }

        const debugEventsMatch = url.pathname.match(/^\/debug\/turns\/([^/]+)\/events$/);
        if (request.method === 'GET' && debugEventsMatch?.[1]) {
          if (!dependencies.eventJournal) {
            return encodeOpenAIError(new AgentLoomError('not_found', 'Debug events not found'));
          }
          return Response.json({
            turn_id: debugEventsMatch[1],
            events: await dependencies.eventJournal.listByTurn(debugEventsMatch[1]),
          });
        }

        if (request.method === 'POST' && url.pathname === '/openai/v1/responses') {
          const body = await request.json();
          const northboundRequest = {
            transport: 'http' as const,
            method: request.method,
            path: url.pathname,
            headers: request.headers,
            body,
          };
          const workspace = await workspaceResolver.resolve(
            await adapter.extractWorkspaceHints(northboundRequest),
            dependencies.config,
          );
          const persistedWorkspace = stateStore
            ? await stateStore.getOrCreateWorkspace({ rootPath: workspace.rootPath })
            : workspace;
          if (!sessionManager) {
            sessionManager = new InMemorySessionManager({ workspace: persistedWorkspace });
          }
          const requestId = crypto.randomUUID();
          const input = await adapter.parseRequest(northboundRequest, {
            workspaceId: persistedWorkspace.id,
            requestId,
          });
          const resolved = await sessionManager.startTurn(input, {
            workspaceId: persistedWorkspace.id,
            requestId,
          });
          const streamAbort = new AbortController();
          const stream = asyncIterableToStream(
            adapter.encodeStream(
              journalCanonicalEvents(
                sessionManager.streamTurn(resolved, streamAbort.signal),
                dependencies.eventJournal,
              ),
              {
                turnId: resolved.turn.id,
                threadId: resolved.thread.id,
                externalResponseId: resolved.externalResponseId ?? resolved.turn.id,
                previousResponseId: input.clientRef?.parentExternalId ?? null,
              },
            ),
            async () => {
              await delay(dependencies.disconnectGraceMs ?? dependencies.config.disconnectGraceMs);
              streamAbort.abort();
              await sessionManager?.cancelTurn(resolved.turn.id);
            },
          );
          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          });
        }

        const responseMatch = url.pathname.match(/^\/openai\/v1\/responses\/([^/]+)$/);
        if (request.method === 'GET' && responseMatch?.[1]) {
          if (!sessionManager) {
            return encodeOpenAIError(new AgentLoomError('not_found', 'Response not found'));
          }
          const clientRef = await stateStore?.resolveClientRef(adapter.protocol, responseMatch[1]);
          const turnId = clientRef?.turnId ?? responseMatch[1];
          const turn = await sessionManager.getTurn(turnId);
          if (!turn) {
            return encodeOpenAIError(new AgentLoomError('not_found', 'Response not found'));
          }
          return Response.json(
            adapter.encodeStoredResponse(
              clientRef ? { ...turn, id: clientRef.externalId } : turn,
              sessionManager.getEvents(turn.id),
              { previousResponseId: clientRef?.parentExternalId ?? null },
            ),
          );
        }

        const cancelMatch = url.pathname.match(/^\/openai\/v1\/responses\/([^/]+)\/cancel$/);
        if (request.method === 'POST' && cancelMatch?.[1]) {
          if (!sessionManager) {
            return encodeOpenAIError(new AgentLoomError('not_found', 'Response not found'));
          }
          const clientRef = await stateStore?.resolveClientRef(adapter.protocol, cancelMatch[1]);
          const turnId = clientRef?.turnId ?? cancelMatch[1];
          const result = await sessionManager.cancelTurn(turnId);
          if (result.status === 'not_found') {
            return encodeOpenAIError(new AgentLoomError('not_found', 'Response not found'));
          }
          const turn = await sessionManager.getTurn(turnId);
          if (!turn) {
            return encodeOpenAIError(new AgentLoomError('not_found', 'Response not found'));
          }
          return Response.json(
            adapter.encodeStoredResponse(
              clientRef ? { ...turn, id: clientRef.externalId } : turn,
              sessionManager.getEvents(turn.id),
              { previousResponseId: clientRef?.parentExternalId ?? null },
            ),
          );
        }

        return encodeOpenAIError(new AgentLoomError('not_found', 'Route not found'));
      } catch (error) {
        return encodeOpenAIError(error);
      }
    },
  };
}

async function* journalCanonicalEvents(
  events: AsyncIterable<AgentEvent>,
  eventJournal: EventJournalInterface | undefined,
): AsyncIterable<AgentEvent> {
  for await (const event of events) {
    if (eventJournal) {
      await eventJournal.append({
        turnId: event.turnId,
        kind: 'canonical',
        canonicalJson: event,
      });
    }
    yield event;
  }
}

function asyncIterableToStream(
  iterable: AsyncIterable<Uint8Array>,
  onCancel?: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel() {
      await onCancel?.();
      await iterator.return?.();
    },
  });
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
