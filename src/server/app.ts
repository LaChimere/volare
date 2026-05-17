import { toVolareError, VolareError } from '../core/errors';
import {
  classifyRequestGrounding,
  evaluateAnswerGrounding,
  type IRequestGroundingHint,
} from '../core/grounding';
import type {
  AgentEvent,
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
  type IOpenAIResponsesStreamFrame,
  type IOpenAIResponsesStreamObserver,
  type OpenAIResponseOutcome,
  OpenAIResponsesAdapter,
} from '../northbound/openai-responses/adapter';
import { requireBearerAuth } from './auth';
import type { IServerRuntimeConfig } from './config';

export interface IAppDependencies {
  config: IServerRuntimeConfig;
  adapter?: OpenAIResponsesAdapter;
  workspaceResolver?: IWorkspaceResolver;
  sessionManager?: ISessionManager;
  stateStore?: IStateStore;
  eventJournal?: IEventJournal;
  logger?: ILogger;
  disconnectGraceMs?: number;
  healthStatus?: () => 'recovering' | 'ready';
}

export function createApp(dependencies: IAppDependencies): {
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
  const turnMetrics = createTurnMetrics();
  const sessionManager = dependencies.sessionManager;

  return {
    async fetch(request: Request): Promise<Response> {
      requestsTotal += 1;
      const requestStartedAt = performance.now();
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
              ...turnMetrics,
            }),
          );
        }

        const openAIPath = openAIResponsesPath(url.pathname);

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
          });
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
            phaseMetrics,
          );
        }

        const responseMatch = openAIPath?.match(/^\/responses\/([^/]+)$/);
        if (request.method === 'GET' && responseMatch?.[1]) {
          if (!sessionManager) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new VolareError('not_found', 'Response not found')),
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
              encodeOpenAIError(new VolareError('not_found', 'Response not found')),
            );
          }
          let events = sessionManager.getEvents(turn.id);
          if (events.length === 0 && dependencies.eventJournal) {
            events = await collectAgentEvents(dependencies.eventJournal.replay(turn.id));
          }
          return logHttpResponse(
            logger,
            logFields,
            requestStartedAt,
            Response.json(
              adapter.encodeStoredResponse(
                clientRef ? { ...turn, id: clientRef.externalId } : turn,
                events,
                { previousResponseId: clientRef?.parentExternalId ?? null },
              ),
            ),
          );
        }

        const cancelMatch = openAIPath?.match(/^\/responses\/([^/]+)\/cancel$/);
        if (request.method === 'POST' && cancelMatch?.[1]) {
          if (!sessionManager) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new VolareError('not_found', 'Response not found')),
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
              encodeOpenAIError(new VolareError('not_found', 'Response not found')),
            );
          }
          const turn = await sessionManager.getTurn(turnId);
          if (!turn) {
            return logHttpResponse(
              logger,
              logFields,
              requestStartedAt,
              encodeOpenAIError(new VolareError('not_found', 'Response not found')),
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
          encodeOpenAIError(new VolareError('not_found', 'Route not found')),
        );
      } catch (error) {
        const response = encodeOpenAIError(error);
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

interface ITurnMetrics {
  turns_total: number;
  turns_with_zero_tools_total: number;
  turns_with_sources_total: number;
  turns_with_citation_like_output_total: number;
  turns_with_grounding_warnings_total: number;
  turns_unmediated_total: number;
}

function createTurnMetrics(): ITurnMetrics {
  return {
    turns_total: 0,
    turns_with_zero_tools_total: 0,
    turns_with_sources_total: 0,
    turns_with_citation_like_output_total: 0,
    turns_with_grounding_warnings_total: 0,
    turns_unmediated_total: 0,
  };
}

async function* observeLiveTurnMetrics(
  events: AsyncIterable<AgentEvent>,
  metrics: ITurnMetrics,
  groundingHint: IRequestGroundingHint,
  unmediatedToolingEnabled: boolean,
): AsyncIterable<AgentEvent> {
  let toolObservedCount = 0;
  for await (const event of events) {
    if (event.type === 'tool.observed') {
      toolObservedCount += 1;
    }
    if (isTerminalEvent(event)) {
      recordTerminalTurnMetrics(
        metrics,
        event,
        toolObservedCount,
        groundingHint,
        unmediatedToolingEnabled,
      );
    }
    yield event;
  }
}

function recordTerminalTurnMetrics(
  metrics: ITurnMetrics,
  event: AgentEvent,
  toolObservedCount: number,
  groundingHint: IRequestGroundingHint,
  unmediatedToolingEnabled: boolean,
): void {
  if (toolObservedCount === 0) {
    metrics.turns_with_zero_tools_total += 1;
  }
  const sourceCount = sourceCountFromTerminalEvent(event);
  if (sourceCount > 0) {
    metrics.turns_with_sources_total += 1;
  }
  if (event.type === 'turn.succeeded') {
    const groundingSignals = evaluateAnswerGrounding({
      outputText: event.output?.text ?? '',
      hint: groundingHint,
      sourceCount,
      toolObservedCount,
      unmediatedToolingEnabled,
    });
    if (groundingSignals.citationLikeOutputCount > 0) {
      metrics.turns_with_citation_like_output_total += 1;
    }
    if (groundingSignals.warningCodes.some(isContentGroundingWarning)) {
      metrics.turns_with_grounding_warnings_total += 1;
    }
  }
}

function recordAcceptedTurnMetrics(metrics: ITurnMetrics, unmediatedToolingEnabled: boolean): void {
  metrics.turns_total += 1;
  if (unmediatedToolingEnabled) {
    metrics.turns_unmediated_total += 1;
  }
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

function isContentGroundingWarning(code: string): boolean {
  return code === 'NEEDS_SOURCES_NO_SOURCES' || code === 'CITATION_LIKE_TEXT_WITHOUT_SOURCES';
}

function isTerminalEvent(event: AgentEvent): boolean {
  return (
    event.type === 'turn.succeeded' ||
    event.type === 'turn.failed' ||
    event.type === 'turn.cancelled' ||
    event.type === 'turn.interrupted'
  );
}

function sourceCountFromTerminalEvent(event: AgentEvent): number {
  if (event.type !== 'turn.succeeded' || !event.output) {
    return 0;
  }
  const sources = (event.output as { sources?: unknown }).sources;
  return Array.isArray(sources) ? sources.length : 0;
}

async function* journalCanonicalEvents(
  events: AsyncIterable<AgentEvent>,
  eventJournal: IEventJournal | undefined,
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

async function collectAgentEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
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

type StreamInterruptionReason = 'client_disconnect' | 'server_aborted' | 'unknown';
type StreamInterruptionPhase = 'pre_first_sse_frame' | 'pre_terminal' | 'post_terminal' | 'unknown';

class StreamLifecycleContext implements IOpenAIResponsesStreamObserver {
  readonly #logger: ILogger;
  #responseCreatedAt = performance.now();
  #firstPullAt: number | undefined;
  #firstSseAt: number | undefined;
  #firstAssistantSseAt: number | undefined;
  #terminalOutcome: OpenAIResponseOutcome | undefined;
  #doneAt: number | undefined;
  #frameCount = 0;
  #cancelled: { reason: StreamInterruptionReason; phase: StreamInterruptionPhase } | undefined;
  #cleanupErrorCode: string | undefined;
  #finalized = false;

  constructor(logger: ILogger) {
    this.#logger = logger;
  }

  recordResponseCreated(): void {
    this.#responseCreatedAt = performance.now();
  }

  recordFirstPull(): void {
    this.#firstPullAt ??= performance.now();
  }

  recordCancellation(reason: StreamInterruptionReason): void {
    this.#cancelled ??= { reason, phase: this.#interruptionPhase() };
  }

  onFrame(frame: IOpenAIResponsesStreamFrame): void {
    const observedAt = performance.now();
    this.#firstSseAt ??= observedAt;
    this.#frameCount += 1;
    if (frame.assistantContent) {
      this.#firstAssistantSseAt ??= observedAt;
    }
    if (frame.terminalOutcome) {
      this.#terminalOutcome = frame.terminalOutcome;
    }
    if (frame.done) {
      this.#doneAt = observedAt;
    }
  }

  finalizeCleanReturn(): void {
    if (this.#terminalOutcome && this.#doneAt !== undefined) {
      this.#finalizeCompleted();
      return;
    }
    if (this.#cancelled) {
      this.#finalizeInterrupted();
      return;
    }
    this.#finalizeFailed('backend_ended_without_terminal');
  }

  finalizeError(error: unknown): void {
    const errorCode = toVolareError(error).code;
    if (this.#cancelled) {
      this.#cleanupErrorCode = errorCode;
      this.#finalizeInterrupted();
      return;
    }
    this.#finalizeFailed(errorCode);
  }

  #finalizeCompleted(): void {
    if (!this.#claimFinalized()) {
      return;
    }
    this.#logger.info(
      {
        event: 'responses.stream.completed',
        responseOutcome: this.#terminalOutcome ?? 'unknown',
        ...this.#baseFields(),
        ...(this.#firstSseAt !== undefined && this.#doneAt !== undefined
          ? { sseActiveMs: elapsedBetweenMs(this.#firstSseAt, this.#doneAt) }
          : {}),
      },
      'responses stream completed',
    );
  }

  #finalizeInterrupted(): void {
    if (!this.#claimFinalized()) {
      return;
    }
    const cancelled = this.#cancelled;
    this.#logger.warn(
      {
        event: 'responses.stream.interrupted',
        interruptionReason: cancelled?.reason ?? 'unknown',
        interruptionPhase: cancelled?.phase ?? 'unknown',
        ...this.#baseFields(),
        ...(this.#cleanupErrorCode ? { cleanupErrorCode: this.#cleanupErrorCode } : {}),
      },
      'responses stream interrupted',
    );
  }

  #finalizeFailed(errorCode: string): void {
    if (!this.#claimFinalized()) {
      return;
    }
    const failedAt = performance.now();
    this.#logger.error(
      {
        event: 'responses.stream.failed',
        errorCode,
        ...this.#baseFields(),
        ...(this.#firstSseAt !== undefined
          ? { sseActiveMs: elapsedBetweenMs(this.#firstSseAt, failedAt) }
          : {}),
      },
      'responses stream failed',
    );
  }

  #baseFields(): ILogFields {
    return {
      sseFrameCount: this.#frameCount,
      ...(this.#firstPullAt !== undefined
        ? { streamStartGapMs: elapsedBetweenMs(this.#responseCreatedAt, this.#firstPullAt) }
        : {}),
      ...(this.#firstPullAt !== undefined && this.#firstAssistantSseAt !== undefined
        ? {
            firstAssistantSseFrameMs: elapsedBetweenMs(
              this.#firstPullAt,
              this.#firstAssistantSseAt,
            ),
          }
        : {}),
    };
  }

  #interruptionPhase(): StreamInterruptionPhase {
    if (this.#firstSseAt === undefined) {
      return 'pre_first_sse_frame';
    }
    if (this.#terminalOutcome && this.#doneAt === undefined) {
      return 'post_terminal';
    }
    if (!this.#terminalOutcome) {
      return 'pre_terminal';
    }
    return 'unknown';
  }

  #claimFinalized(): boolean {
    if (this.#finalized) {
      return false;
    }
    this.#finalized = true;
    return true;
  }
}

function elapsedBetweenMs(startedAt: number, endedAt: number): number {
  return Math.round(endedAt - startedAt);
}

interface IStreamOptions {
  onFirstPull?: () => void;
  onCancel?: () => Promise<void>;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
}

function asyncIterableToStream(
  iterable: AsyncIterable<Uint8Array>,
  options: IStreamOptions = {},
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  let firstPull = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstPull) {
        firstPull = false;
        options.onFirstPull?.();
      }
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          options.onComplete?.();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    },
    async cancel() {
      let cancelError: unknown;
      try {
        await options.onCancel?.();
      } catch (error) {
        cancelError = error;
      }
      try {
        await iterator.return?.();
      } catch (returnError) {
        if (cancelError) {
          const cleanupError = new AggregateError(
            [cancelError, returnError],
            'Stream cancellation cleanup failed',
          );
          options.onError?.(cleanupError);
          throw cleanupError;
        }
        options.onError?.(returnError);
        throw returnError;
      }
      if (cancelError) {
        options.onError?.(cancelError);
        throw cancelError;
      }
      options.onComplete?.();
    },
  });
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
