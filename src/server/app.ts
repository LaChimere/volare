import { toVolareError, VolareError } from '../core/errors';
import { classifyRequestGrounding } from '../core/grounding';
import type { IRuntimeCapabilityRegistry } from '../core/runtime-capability-registry';
import type {
  ApprovalDecision,
  IApprovalNotifier,
  IApprovalResolutionRequest,
  IApprovalResolutionResult,
  IEventJournal,
  ISessionManager,
  IStateStore,
  IWorkspaceResolver,
} from '../core/types';
import { WorkspaceResolver } from '../core/workspace-resolver';
import { type ILogFields, type ILogger, NoopLogger } from '../logging/logger';
import {
  createCodexModelsResponse,
  encodeOpenAIError,
  OpenAIResponsesAdapter,
} from '../northbound/openai-responses/adapter';
import { requireBearerAuth } from './auth';
import { encodeCapabilitiesResponse } from './capabilities-route';
import type { IServerRuntimeConfig } from './config';
import { journalCanonicalEvents } from './event-streams';
import { handleCancelOpenAIResponse, handleStoredOpenAIResponse } from './openai-response-routes';
import { asyncIterableToStream } from './readable-stream';
import { StreamLifecycleContext } from './stream-lifecycle';
import {
  createTurnMetrics,
  observeLiveTurnMetrics,
  recordAcceptedTurnMetrics,
} from './turn-metrics';

export interface IAppDependencies {
  config: IServerRuntimeConfig;
  adapter?: OpenAIResponsesAdapter;
  workspaceResolver?: IWorkspaceResolver;
  sessionManager?: ISessionManager;
  approvalNotifier?: IApprovalNotifier;
  stateStore?: IStateStore;
  eventJournal?: IEventJournal;
  capabilityRegistry?: IRuntimeCapabilityRegistry;
  logger?: ILogger;
  disconnectGraceMs?: number;
  healthStatus?: () => 'recovering' | 'ready';
  workerMetrics?: () => Record<string, number>;
}

export function createApp(dependencies: IAppDependencies): {
  fetch(request: Request): Promise<Response>;
} {
  const stateStore = dependencies.stateStore;
  const baseLogger = dependencies.logger ?? new NoopLogger();
  const adapter = dependencies.adapter ?? new OpenAIResponsesAdapter(stateStore, baseLogger);
  const logger = baseLogger.child({ component: 'server' });
  const workspaceResolver =
    dependencies.workspaceResolver ?? new WorkspaceResolver({ logger: baseLogger });
  const startedAt = Date.now();
  let requestsTotal = 0;
  const turnMetrics = createTurnMetrics();
  const sessionManager = dependencies.sessionManager;
  const approvalNotifier = dependencies.approvalNotifier;

  return {
    async fetch(request: Request): Promise<Response> {
      requestsTotal += 1;
      const requestStartedAt = performance.now();
      const requestId = crypto.randomUUID();
      const url = new URL(request.url);
      const isControlPlaneRequest = isControlPlanePath(url.pathname);
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
              ...turnMetrics,
              ...(dependencies.workerMetrics?.() ?? {}),
            }),
          );
        }

        if (request.method === 'GET' && url.pathname === '/capabilities') {
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            encodeCapabilitiesResponse({
              config: dependencies.config,
              adapterCapabilities: adapter.capabilities(),
              capabilityRegistry: dependencies.capabilityRegistry,
              healthStatus: dependencies.healthStatus?.() ?? 'ready',
            }),
          );
        }

        const openAIPath = openAIResponsesPath(url.pathname);

        const approvalResolveMatch = url.pathname.match(/^\/control\/approvals\/([^/]+)\/resolve$/);
        if (request.method === 'POST' && approvalResolveMatch?.[1]) {
          if (!approvalNotifier) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeControlPlaneError(
                new VolareError('internal_error', 'Approval notifier is not configured'),
              ),
            );
          }
          const body = await parseJsonBody(request);
          const resolutionInput = parseApprovalResolutionRequest(approvalResolveMatch[1], body);
          const result = await approvalNotifier.resolveApproval(resolutionInput);
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            Response.json(encodeApprovalResolutionResponse(resolutionInput, result)),
          );
        }

        if (request.method === 'GET' && openAIPath === '/models') {
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
              encodeOpenAIError(new VolareError('not_found', 'Debug events not found')),
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

        if (request.method === 'POST' && openAIPath === '/responses') {
          const phaseMetrics: ILogFields = {};
          let phaseStartedAt = performance.now();
          const body = await parseJsonBody(request);
          phaseMetrics['bodyParseMs'] = elapsedMs(phaseStartedAt);
          const northboundRequest = {
            transport: 'http' as const,
            method: request.method,
            path: url.pathname,
            headers: request.headers,
            body,
          };
          phaseStartedAt = performance.now();
          const workspaceHints = await adapter.extractWorkspaceHints(northboundRequest);
          phaseMetrics['workspaceHintMs'] = elapsedMs(phaseStartedAt);
          phaseStartedAt = performance.now();
          const workspace = await workspaceResolver.resolve(workspaceHints, dependencies.config);
          const persistedWorkspace = stateStore
            ? await stateStore.getOrCreateWorkspace({ rootPath: workspace.rootPath })
            : workspace;
          phaseMetrics['workspaceResolveMs'] = elapsedMs(phaseStartedAt);
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
          phaseStartedAt = performance.now();
          const input = await adapter.parseRequest(northboundRequest, {
            workspaceId: persistedWorkspace.id,
            requestId,
          });
          phaseMetrics['adapterParseMs'] = elapsedMs(phaseStartedAt);
          const reasoningEffort = reasoningEffortFromRequestBody(northboundRequest.body);
          if (!sessionManager) {
            throw new VolareError('internal_error', 'Session manager is not configured');
          }
          phaseStartedAt = performance.now();
          const resolved = await sessionManager.startTurn(input, {
            workspaceId: persistedWorkspace.id,
            requestId,
            signal: request.signal,
          });
          let streamOwnershipTransferred = false;
          try {
            phaseMetrics['sessionStartMs'] = elapsedMs(phaseStartedAt);
            const streamLogger = logger.child({
              requestId,
              workspaceId: persistedWorkspace.id,
              threadId: resolved.thread.id,
              turnId: resolved.turn.id,
              responseId: resolved.externalResponseId ?? resolved.turn.id,
            });
            const unmediatedToolingEnabled = dependencies.config.copilotMcpMode === 'unmediated';
            recordAcceptedTurnMetrics(turnMetrics, unmediatedToolingEnabled);
            logTurnAudit(streamLogger, {
              sessionId: resolved.session.bridgeSessionId,
              copilotMcpMode: dependencies.config.copilotMcpMode,
              copilotPermissionMode: dependencies.config.copilotPermissionMode,
              unmediatedToolingEnabled,
            });
            streamLogger.info(
              {
                event: 'responses.stream.started',
                model: input.model,
                ...(reasoningEffort ? { reasoningEffort } : {}),
              },
              'responses stream started',
            );
            const streamAbort = new AbortController();
            const streamLifecycle = new StreamLifecycleContext(streamLogger);
            const stream = asyncIterableToStream(
              adapter.encodeStream(
                journalCanonicalEvents(
                  observeLiveTurnMetrics(
                    sessionManager.streamTurn(resolved, streamAbort.signal),
                    turnMetrics,
                    classifyRequestGrounding(input.input),
                    unmediatedToolingEnabled,
                  ),
                  dependencies.eventJournal,
                ),
                {
                  turnId: resolved.turn.id,
                  threadId: resolved.thread.id,
                  parentTurnId: resolved.turn.parentTurnId,
                  bridgeSessionId: resolved.turn.bridgeSessionId,
                  externalResponseId: resolved.externalResponseId ?? resolved.turn.id,
                  previousResponseId: input.clientRef?.parentExternalId ?? null,
                  requestInput: input.input,
                  ...(input.metadata ? { requestMetadata: input.metadata } : {}),
                  model: resolved.turn.model,
                  createdAt: resolved.turn.createdAt,
                },
                streamLifecycle,
              ),
              {
                onFirstPull: () => {
                  streamLifecycle.recordFirstPull();
                },
                onCancel: async () => {
                  streamLifecycle.recordCancellation('client_disconnect');
                  await delay(
                    dependencies.disconnectGraceMs ?? dependencies.config.disconnectGraceMs,
                  );
                  streamAbort.abort();
                  await sessionManager?.cancelTurn(resolved.turn.id);
                },
                onComplete: () => {
                  streamLifecycle.finalizeCleanReturn();
                },
                onError: (error) => {
                  streamLifecycle.finalizeError(error);
                },
              },
            );
            streamLifecycle.recordResponseCreated();
            const response = logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              new Response(stream, {
                headers: {
                  'Content-Type': 'text/event-stream; charset=utf-8',
                  'Cache-Control': 'no-cache',
                },
              }),
              phaseMetrics,
            );
            streamOwnershipTransferred = true;
            return response;
          } catch (error) {
            if (!streamOwnershipTransferred) {
              try {
                await sessionManager.cancelTurn(resolved.turn.id);
              } catch (cleanupError) {
                const agentError = toVolareError(cleanupError);
                logger.error(
                  {
                    event: 'responses.stream.setup_cleanup_failed',
                    requestId,
                    workspaceId: persistedWorkspace.id,
                    threadId: resolved.thread.id,
                    turnId: resolved.turn.id,
                    errorCode: agentError.code,
                    error: agentError,
                  },
                  'responses stream setup cleanup failed',
                );
              }
            }
            throw error;
          }
        }

        const responseMatch = openAIPath?.match(/^\/responses\/([^/]+)$/);
        if (request.method === 'GET' && responseMatch?.[1]) {
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            await handleStoredOpenAIResponse({
              responseId: responseMatch[1],
              adapter,
              sessionManager,
              stateStore,
              eventJournal: dependencies.eventJournal,
            }),
          );
        }

        const cancelMatch = openAIPath?.match(/^\/responses\/([^/]+)\/cancel$/);
        if (request.method === 'POST' && cancelMatch?.[1]) {
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            await handleCancelOpenAIResponse({
              responseId: cancelMatch[1],
              adapter,
              sessionManager,
              stateStore,
              eventJournal: dependencies.eventJournal,
            }),
          );
        }

        const routeNotFound = new VolareError('not_found', 'Route not found');
        return logHttpResponse(
          logger,
          logFields,
          requestStartedAt,
          isControlPlaneRequest
            ? encodeControlPlaneError(routeNotFound)
            : encodeOpenAIError(routeNotFound),
        );
      } catch (error) {
        const response = isControlPlaneRequest
          ? encodeControlPlaneError(error)
          : encodeOpenAIError(error);
        const agentError = toVolareError(error);
        return logHttpResponse(logger, logFields, requestStartedAt, response, {
          errorCode: agentError.code,
        });
      }
    },
  };
}

function openAIResponsesPath(pathname: string): string | undefined {
  for (const basePath of ['/openai/v1', '/v1']) {
    if (pathname.startsWith(`${basePath}/`)) {
      return pathname.slice(basePath.length);
    }
  }
  return undefined;
}

function isControlPlanePath(pathname: string): boolean {
  return pathname === '/capabilities' || pathname.startsWith('/control/');
}

function parseApprovalResolutionRequest(
  approvalId: string,
  body: unknown,
): IApprovalResolutionRequest {
  if (!isRecord(body)) {
    throw new VolareError('invalid_request', 'Approval resolution body must be a JSON object');
  }
  return {
    approvalId,
    turnId: requiredStringField(body, 'turn_id'),
    bridgeSessionId: requiredStringField(body, 'bridge_session_id'),
    decision: parseManualApprovalDecision(body['decision']),
  };
}

function parseManualApprovalDecision(value: unknown): ApprovalDecision {
  if (!isRecord(value)) {
    throw new VolareError('invalid_request', 'Approval decision must be a JSON object');
  }
  const type = value['type'];
  if (type !== 'allow' && type !== 'deny') {
    throw new VolareError('invalid_request', 'Approval decision type must be allow or deny');
  }
  const scope = value['scope'];
  if (scope !== 'once' && scope !== 'always') {
    throw new VolareError('invalid_request', 'Approval decision scope must be once or always');
  }
  if (type === 'allow') {
    return { type, scope };
  }
  const reason = value['reason'];
  return {
    type,
    scope,
    ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}),
  };
}

function requiredStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new VolareError('invalid_request', `Approval resolution ${field} is required`);
  }
  return value;
}

function encodeApprovalResolutionResponse(
  input: IApprovalResolutionRequest,
  result: IApprovalResolutionResult,
): unknown {
  return {
    approval_id: input.approvalId,
    turn_id: input.turnId,
    bridge_session_id: input.bridgeSessionId,
    status: result.status,
    decision: result.decision,
  };
}

function encodeControlPlaneError(error: unknown): Response {
  const agentError = toVolareError(error);
  return Response.json(
    {
      error: {
        code: agentError.code,
        message: agentError.message,
      },
    },
    { status: controlPlaneStatusForErrorCode(agentError.code) },
  );
}

function controlPlaneStatusForErrorCode(code: string): number {
  switch (code) {
    case 'invalid_request':
    case 'unsupported_parameter':
      return 400;
    case 'unauthorized':
      return 401;
    case 'workspace_forbidden':
      return 403;
    case 'approval_not_found':
    case 'not_found':
      return 404;
    case 'approval_scope_mismatch':
      return 409;
    case 'service_unavailable':
      return 503;
    default:
      return 500;
  }
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (cause) {
    throw new VolareError('invalid_request', 'Malformed JSON body', { cause });
  }
}

function reasoningEffortFromRequestBody(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const reasoning = body['reasoning'];
  if (isRecord(reasoning)) {
    const effort = reasoning['effort'];
    if (typeof effort === 'string') {
      return effort;
    }
  }
  for (const key of ['reasoning_effort', 'model_reasoning_effort']) {
    const effort = body[key];
    if (typeof effort === 'string') {
      return effort;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function logTurnAudit(
  logger: ILogger,
  fields: {
    sessionId: string;
    copilotMcpMode: string;
    copilotPermissionMode: string;
    unmediatedToolingEnabled: boolean;
  },
): void {
  const logFields = { event: 'turn.audit', ...fields };
  if (fields.unmediatedToolingEnabled) {
    logger.warn(logFields, 'turn audit');
    return;
  }
  logger.info(logFields, 'turn audit');
}

function logHttpResponse(
  logger: ILogger,
  fields: { requestId: string; method: string; path: string },
  startedAt: number,
  response: Response,
  extra: ILogFields = {},
): Response {
  const logFields = {
    event: 'http.request.completed',
    ...fields,
    ...extra,
    status: response.status,
    durationMs: elapsedMs(startedAt),
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

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
