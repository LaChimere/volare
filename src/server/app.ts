import { DefaultApprovalPolicy } from '../approvals/policy';
import { ApprovalProvider } from '../approvals/provider';
import { MockBackend } from '../backends/mock/backend';
import { DurableSessionManager } from '../core/durable-session-manager';
import { AgentLoomError, toAgentLoomError } from '../core/errors';
import { InMemorySessionManager } from '../core/in-memory-session-manager';
import type {
  AgentEvent,
  EventJournalInterface,
  SessionManagerInterface,
  StateStoreInterface,
} from '../core/types';
import { WorkspaceResolver } from '../core/workspace-resolver';
import { type LogFieldsInterface, type LoggerInterface, NoopLogger } from '../logging/logger';
import {
  createCodexModelsResponse,
  encodeOpenAIError,
  OpenAIResponsesAdapter,
} from '../northbound/openai-responses/adapter';
import { requireBearerAuth } from './auth';
import type { ServerRuntimeConfigInterface } from './config';

export interface AppDependenciesInterface {
  config: ServerRuntimeConfigInterface;
  adapter?: OpenAIResponsesAdapter;
  workspaceResolver?: WorkspaceResolver;
  sessionManager?: SessionManagerInterface;
  stateStore?: StateStoreInterface;
  eventJournal?: EventJournalInterface;
  logger?: LoggerInterface;
  disconnectGraceMs?: number;
  healthStatus?: () => 'recovering' | 'ready';
}

export function createApp(dependencies: AppDependenciesInterface): {
  fetch(request: Request): Promise<Response>;
} {
  const stateStore = dependencies.stateStore;
  const adapter = dependencies.adapter ?? new OpenAIResponsesAdapter(stateStore);
  const baseLogger = dependencies.logger ?? new NoopLogger();
  const logger = baseLogger.child({ component: 'server' });
  const workspaceResolver =
    dependencies.workspaceResolver ?? new WorkspaceResolver({ logger: baseLogger });
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
            logger: baseLogger,
          }),
          cancelTimeoutMs: dependencies.config.cancelTimeoutMs,
          logger: baseLogger,
        })
      : undefined);

  return {
    async fetch(request: Request): Promise<Response> {
      requestsTotal += 1;
      const requestStartedAt = Date.now();
      const requestId = crypto.randomUUID();
      const url = new URL(request.url);
      const logFields = {
        requestId,
        method: request.method,
        path: url.pathname,
      };
      try {
        requireBearerAuth(request, dependencies.config.apiKey);

        if (request.method === 'GET' && url.pathname === '/healthz') {
          const status = dependencies.healthStatus?.() ?? 'ready';
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            Response.json(
              {
                status,
              },
              { status: status === 'ready' ? 200 : 503 },
            ),
          );
        }

        if (request.method === 'GET' && url.pathname === '/metrics') {
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            Response.json({
              status: dependencies.healthStatus?.() ?? 'ready',
              uptime_ms: Date.now() - startedAt,
              requests_total: requestsTotal,
            }),
          );
        }

        if (request.method === 'GET' && url.pathname === '/openai/v1/models') {
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            Response.json(createCodexModelsResponse()),
          );
        }

        const debugEventsMatch = url.pathname.match(/^\/debug\/turns\/([^/]+)\/events$/);
        if (request.method === 'GET' && debugEventsMatch?.[1]) {
          if (!dependencies.eventJournal) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new AgentLoomError('not_found', 'Debug events not found')),
            );
          }
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            Response.json({
              turn_id: debugEventsMatch[1],
              events: await dependencies.eventJournal.listByTurn(debugEventsMatch[1]),
            }),
          );
        }

        if (request.method === 'POST' && url.pathname === '/openai/v1/responses') {
          const body = await parseJsonBody(request);
          const northboundRequest = {
            transport: 'http' as const,
            method: request.method,
            path: url.pathname,
            headers: request.headers,
            body,
          };
          const workspaceHints = await adapter.extractWorkspaceHints(northboundRequest);
          const workspace = await workspaceResolver.resolve(workspaceHints, dependencies.config);
          const persistedWorkspace = stateStore
            ? await stateStore.getOrCreateWorkspace({ rootPath: workspace.rootPath })
            : workspace;
          logger.info(
            {
              event: 'workspace.selected',
              requestId,
              workspaceId: persistedWorkspace.id,
              requestedRootSource: workspaceHints.source,
              projectless:
                !workspaceHints.requestedRoot &&
                (workspaceHints.source === 'process-cwd' ||
                  workspaceHints.source === 'projectless') &&
                dependencies.config.projectlessWorkspaceRoot !== undefined,
            },
            'workspace selected',
          );
          if (!sessionManager) {
            sessionManager = new InMemorySessionManager({ workspace: persistedWorkspace });
          }
          const input = await adapter.parseRequest(northboundRequest, {
            workspaceId: persistedWorkspace.id,
            requestId,
          });
          const resolved = await sessionManager.startTurn(input, {
            workspaceId: persistedWorkspace.id,
            requestId,
          });
          const streamLogger = logger.child({
            requestId,
            workspaceId: persistedWorkspace.id,
            threadId: resolved.thread.id,
            turnId: resolved.turn.id,
            responseId: resolved.externalResponseId ?? resolved.turn.id,
          });
          streamLogger.info({ event: 'responses.stream.started' }, 'responses stream started');
          const streamAbort = new AbortController();
          const stream = asyncIterableToStream(
            adapter.encodeStream(
              logAgentEventStream(
                journalCanonicalEvents(
                  sessionManager.streamTurn(resolved, streamAbort.signal),
                  dependencies.eventJournal,
                ),
                streamLogger,
              ),
              {
                turnId: resolved.turn.id,
                threadId: resolved.thread.id,
                externalResponseId: resolved.externalResponseId ?? resolved.turn.id,
                previousResponseId: input.clientRef?.parentExternalId ?? null,
                requestInput: input.input,
              },
            ),
            async () => {
              await delay(dependencies.disconnectGraceMs ?? dependencies.config.disconnectGraceMs);
              streamAbort.abort();
              await sessionManager?.cancelTurn(resolved.turn.id);
              streamLogger.warn(
                { event: 'responses.stream.cancelled' },
                'responses stream cancelled',
              );
            },
          );
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            new Response(stream, {
              headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
              },
            }),
          );
        }

        const responseMatch = url.pathname.match(/^\/openai\/v1\/responses\/([^/]+)$/);
        if (request.method === 'GET' && responseMatch?.[1]) {
          if (!sessionManager) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new AgentLoomError('not_found', 'Response not found')),
            );
          }
          const clientRef = await stateStore?.resolveClientRef(adapter.protocol, responseMatch[1]);
          const turnId = clientRef?.turnId ?? responseMatch[1];
          const turn = await sessionManager.getTurn(turnId);
          if (!turn) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new AgentLoomError('not_found', 'Response not found')),
            );
          }
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            Response.json(
              adapter.encodeStoredResponse(
                clientRef ? { ...turn, id: clientRef.externalId } : turn,
                sessionManager.getEvents(turn.id),
                { previousResponseId: clientRef?.parentExternalId ?? null },
              ),
            ),
          );
        }

        const cancelMatch = url.pathname.match(/^\/openai\/v1\/responses\/([^/]+)\/cancel$/);
        if (request.method === 'POST' && cancelMatch?.[1]) {
          if (!sessionManager) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new AgentLoomError('not_found', 'Response not found')),
            );
          }
          const clientRef = await stateStore?.resolveClientRef(adapter.protocol, cancelMatch[1]);
          const turnId = clientRef?.turnId ?? cancelMatch[1];
          const result = await sessionManager.cancelTurn(turnId);
          if (result.status === 'not_found') {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new AgentLoomError('not_found', 'Response not found')),
            );
          }
          const turn = await sessionManager.getTurn(turnId);
          if (!turn) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new AgentLoomError('not_found', 'Response not found')),
            );
          }
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            Response.json(
              adapter.encodeStoredResponse(
                clientRef ? { ...turn, id: clientRef.externalId } : turn,
                sessionManager.getEvents(turn.id),
                { previousResponseId: clientRef?.parentExternalId ?? null },
              ),
            ),
          );
        }

        return logHttpResponse(
          logger,
          logFields,
          requestStartedAt,
          encodeOpenAIError(new AgentLoomError('not_found', 'Route not found')),
        );
      } catch (error) {
        const response = encodeOpenAIError(error);
        const agentError = toAgentLoomError(error);
        return logHttpResponse(logger, logFields, requestStartedAt, response, {
          errorCode: agentError.code,
          ...(response.status >= 500 ? { error: agentError } : {}),
        });
      }
    },
  };
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (cause) {
    throw new AgentLoomError('invalid_request', 'Malformed JSON body', { cause });
  }
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

async function* logAgentEventStream(
  events: AsyncIterable<AgentEvent>,
  logger: LoggerInterface,
): AsyncIterable<AgentEvent> {
  const startedAt = Date.now();
  let completed = false;
  let failed = false;
  try {
    for await (const event of events) {
      yield event;
    }
    completed = true;
    logger.info(
      { event: 'responses.stream.completed', durationMs: Date.now() - startedAt },
      'responses stream completed',
    );
  } catch (error) {
    failed = true;
    const agentError = toAgentLoomError(error);
    logger.error(
      {
        event: 'responses.stream.failed',
        durationMs: Date.now() - startedAt,
        errorCode: agentError.code,
        error: agentError,
      },
      'responses stream failed',
    );
    throw error;
  } finally {
    if (!completed && !failed) {
      logger.warn(
        { event: 'responses.stream.interrupted', durationMs: Date.now() - startedAt },
        'responses stream interrupted',
      );
    }
  }
}

function logHttpResponse(
  logger: LoggerInterface,
  fields: { requestId: string; method: string; path: string },
  startedAt: number,
  response: Response,
  extra: LogFieldsInterface = {},
): Response {
  const logFields = {
    event: 'http.request.completed',
    ...fields,
    ...extra,
    status: response.status,
    durationMs: Date.now() - startedAt,
  };
  if (response.status >= 500) {
    logger.error(logFields, 'http request completed');
  } else if (response.status >= 400) {
    logger.warn(logFields, 'http request completed');
  } else {
    logger.info(logFields, 'http request completed');
  }
  return response;
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
