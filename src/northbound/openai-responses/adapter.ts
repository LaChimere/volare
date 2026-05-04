import { toVolareError, VolareError } from '../../core/errors';
import { createId } from '../../core/ids';
import type {
  AgentEvent,
  IAgentAttachment,
  IAgentRequestInput,
  IAgentUsage,
  INorthboundAdapter,
  INorthboundCapabilities,
  INorthboundRequest,
  IRequestContext,
  IResponseContext,
  IStateStore,
  ITurnRecord,
  IVolareError,
  IWorkspaceHints,
} from '../../core/types';
import {
  createEstimatedUsageFromTokens,
  estimateAgentInputTokens,
  estimateTextTokens,
} from '../../core/usage';
import { codexWorkspaceHintsFromRequest } from './codex-workspace-hints';

const encoder = new TextEncoder();
const CLIENT_CONTEXT_ONLY_TAGS = new Set([
  'available_skills',
  'environment_context',
  'skills_instructions',
  'startup_context',
  'system_reminder',
]);

export class OpenAIResponsesAdapter implements INorthboundAdapter {
  readonly protocol = 'openai-responses-v1';

  constructor(readonly stateStore?: IStateStore) {}

  async extractWorkspaceHints(request: INorthboundRequest): Promise<IWorkspaceHints> {
    const metadata = metadataFromRequestBody(request.body);
    const requestedRoot = metadata ? stringValue(metadata['workspace_root']) : undefined;
    if (requestedRoot) {
      return { source: 'client-metadata', requestedRoot };
    }
    const codexHints = codexWorkspaceHintsFromRequest(request, metadata);
    if (codexHints) {
      return codexHints;
    }
    return { source: 'process-cwd' };
  }

  async parseRequest(
    request: INorthboundRequest,
    _context: IRequestContext,
  ): Promise<IAgentRequestInput> {
    if (!isRecord(request.body)) {
      throw new VolareError('invalid_request', 'Responses request body must be a JSON object');
    }
    if (request.body['stream'] === false) {
      throw new VolareError(
        'unsupported_parameter',
        'Responses request stream=false is not supported; Volare streams every response',
      );
    }
    const tools = request.body['tools'];
    if (tools !== undefined && !Array.isArray(tools)) {
      throw new VolareError('invalid_request', 'Responses request tools must be an array');
    }

    const model = stringValue(request.body['model']);
    if (!model) {
      throw new VolareError('invalid_request', 'Responses request requires a model');
    }

    const parsedInput = parseInput(request.body['input']);
    if (!parsedInput) {
      throw new VolareError('invalid_request', 'Responses request requires text input');
    }
    const requestInstructions = stringValue(request.body['instructions']);
    const systemInstructions = [
      requestInstructions && !isCodexHarnessInstructions(requestInstructions)
        ? requestInstructions
        : undefined,
      parsedInput.systemInstructions,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n\n');

    const previousResponseId = stringValue(request.body['previous_response_id']);
    const parentRef = previousResponseId
      ? await this.stateStore?.resolveClientRef(this.protocol, previousResponseId)
      : null;
    if (previousResponseId && this.stateStore && !parentRef) {
      throw new VolareError('not_found', 'previous_response_id was not found');
    }
    const metadata = metadataFromRequestBody(request.body);
    return {
      ...(parentRef ? { threadId: parentRef.threadId, parentTurnId: parentRef.turnId } : {}),
      model,
      input: {
        message: parsedInput.message,
        ...(parsedInput.conversationHistory.length > 0
          ? { conversationHistory: parsedInput.conversationHistory }
          : {}),
        ...(systemInstructions ? { systemInstructions } : {}),
        ...(parsedInput.attachments.length > 0 ? { attachments: parsedInput.attachments } : {}),
      },
      ...(metadata ? { metadata } : {}),
      clientRef: {
        protocol: this.protocol,
        externalId: createId('resp'),
        ...(parentRef ? { parentProtocol: parentRef.protocol } : {}),
        ...(previousResponseId ? { parentExternalId: previousResponseId } : {}),
      },
    };
  }

  async *encodeStream(
    events: AsyncIterable<AgentEvent>,
    context: IResponseContext,
  ): AsyncIterable<Uint8Array> {
    const responseId = context.externalResponseId ?? context.turnId;
    const messageItemId = `msg_${responseId}`;
    let sequenceNumber = 0;
    const replayedEvents: AgentEvent[] = [];
    let textStarted = false;
    let text = '';

    yield encodeSse({
      type: 'response.created',
      sequence_number: sequenceNumber++,
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
      },
    });
    yield encodeSse({
      type: 'response.in_progress',
      sequence_number: sequenceNumber++,
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
      },
    });

    for await (const event of events) {
      replayedEvents.push(event);
      switch (event.type) {
        case 'turn.created':
          break;
        case 'text.delta':
          if (!textStarted) {
            textStarted = true;
            yield encodeSse({
              type: 'response.output_item.added',
              sequence_number: sequenceNumber++,
              output_index: 0,
              item: {
                id: messageItemId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            });
          }
          text += event.delta;
          yield encodeSse({
            type: 'response.output_text.delta',
            sequence_number: sequenceNumber++,
            item_id: messageItemId,
            output_index: 0,
            content_index: 0,
            delta: event.delta,
          });
          break;
        case 'turn.succeeded':
          if (textStarted) {
            yield encodeSse({
              type: 'response.output_item.done',
              sequence_number: sequenceNumber++,
              output_index: 0,
              item: {
                id: messageItemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text }],
              },
            });
          }
          yield encodeSse({
            type: 'response.completed',
            sequence_number: sequenceNumber++,
            response: this.encodeStoredResponse(
              {
                id: responseId,
                threadId: context.threadId,
                parentTurnId: context.parentTurnId ?? null,
                bridgeSessionId: context.bridgeSessionId ?? '',
                status: 'succeeded',
                model: context.model ?? '',
                createdAt: context.createdAt ?? new Date(),
                completedAt: new Date(),
              },
              replayedEvents,
              {
                previousResponseId: context.previousResponseId ?? null,
                ...(context.requestMetadata ? { metadata: context.requestMetadata } : {}),
              },
            ),
          });
          yield encoder.encode('data: [DONE]\n\n');
          return;
        case 'turn.failed':
          if (textStarted) {
            yield encodeSse({
              type: 'response.output_item.done',
              sequence_number: sequenceNumber++,
              output_index: 0,
              item: {
                id: messageItemId,
                type: 'message',
                status: 'incomplete',
                role: 'assistant',
                content: [{ type: 'output_text', text }],
              },
            });
          }
          yield encodeSse({
            type: 'response.failed',
            sequence_number: sequenceNumber++,
            response: {
              id: responseId,
              object: 'response',
              status: 'failed',
              error: toResponseError(event.error),
              usage: usageForStream(event, context, text),
            },
          });
          yield encoder.encode('data: [DONE]\n\n');
          return;
        case 'turn.cancelled':
        case 'turn.interrupted':
          if (textStarted) {
            yield encodeSse({
              type: 'response.output_item.done',
              sequence_number: sequenceNumber++,
              output_index: 0,
              item: {
                id: messageItemId,
                type: 'message',
                status: 'incomplete',
                role: 'assistant',
                content: [{ type: 'output_text', text }],
              },
            });
          }
          yield encodeSse({
            type: 'response.incomplete',
            sequence_number: sequenceNumber++,
            response: {
              id: responseId,
              object: 'response',
              status: 'incomplete',
              incomplete_details: { reason: incompleteReason(event) },
              usage: usageForStream(event, context, text),
            },
          });
          yield encoder.encode('data: [DONE]\n\n');
          return;
        default:
          break;
      }
    }

    yield encoder.encode('data: [DONE]\n\n');
  }

  encodeStoredResponse(
    record: ITurnRecord,
    events: AgentEvent[],
    options: { previousResponseId?: string | null; metadata?: Record<string, unknown> } = {},
  ): unknown {
    const text = events
      .filter(
        (event): event is Extract<AgentEvent, { type: 'text.delta' }> =>
          event.type === 'text.delta',
      )
      .map((event) => event.delta)
      .join('');
    const output = text
      ? [
          {
            id: `msg_${record.id}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        ]
      : [];

    return {
      id: record.id,
      object: 'response',
      created_at: Math.floor(record.createdAt.getTime() / 1000),
      status: toOpenAIStatus(record.status),
      model: record.model,
      output,
      error: errorFromEvents(events),
      incomplete_details: incompleteDetailsFromEvents(events),
      usage: usageFromEvents(events, text),
      previous_response_id: options.previousResponseId ?? null,
      metadata: options.metadata ?? metadataFromEvents(events) ?? null,
    };
  }

  encodeError(error: IVolareError): unknown {
    return {
      error: {
        type: error.code,
        message: error.message,
      },
    };
  }

  capabilities(): INorthboundCapabilities {
    return {
      streaming: true,
      resumableTurns: false,
      clientSideToolCalls: false,
      cancellation: true,
    };
  }
}

export function createCodexModelsResponse(): unknown {
  return {
    models: [
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        description: 'Volare bridge to a Copilot-backed local agent runtime.',
        default_reasoning_level: null,
        supported_reasoning_levels: [],
        shell_type: 'shell_command',
        visibility: 'list',
        supported_in_api: true,
        priority: 1,
        upgrade: null,
        availability_nux: null,
        base_instructions: '',
        supports_reasoning_summaries: false,
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: null,
        truncation_policy: { mode: 'bytes', limit: 100_000 },
        supports_parallel_tool_calls: false,
        supports_image_detail_original: false,
        context_window: 128_000,
        experimental_supported_tools: [],
        input_modalities: ['text'],
      },
    ],
  };
}

export function encodeOpenAIError(error: unknown): Response {
  const agentError = toVolareError(error);
  const status = statusForErrorCode(agentError.code);
  return Response.json(new OpenAIResponsesAdapter().encodeError(agentError), { status });
}

function encodeSse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

interface IParsedInput {
  message: string;
  conversationHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  systemInstructions?: string;
  attachments: IAgentAttachment[];
}

type ParsedMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments: IAgentAttachment[];
};

function parseInput(input: unknown): IParsedInput | null {
  if (typeof input === 'string') {
    const message = input.trim();
    return message ? { message, conversationHistory: [], attachments: [] } : null;
  }
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.every((item) => typeof item === 'string')) {
    const message = input.join('\n').trim();
    return message ? { message, conversationHistory: [], attachments: [] } : null;
  }

  const messages = input.flatMap((item): ParsedMessage[] => {
    if (typeof item === 'string') {
      const content = item.trim();
      return content ? [{ role: 'user', content, attachments: [] }] : [];
    }
    if (!isRecord(item)) {
      return [];
    }
    const parsedContent = parseContent(item['content']);
    const content = parsedContent.textParts.join('\n').trim();
    if (!content) {
      return [];
    }
    return [
      {
        role: roleFromInputItem(item),
        content,
        attachments: parsedContent.attachments,
      },
    ];
  });
  const systemInstructions = messages
    .filter((message) => message.role === 'system' && !isClientContextOnlyMessage(message))
    .map((message) => message.content)
    .join('\n\n');
  const nonSystemMessages = messages.filter(
    (message) => message.role !== 'system' && !isClientContextOnlyMessage(message),
  );
  const latestIndex = nonSystemMessages.length - 1;
  const latest = nonSystemMessages[latestIndex];
  if (!latest) {
    return null;
  }
  if (latest.role !== 'user') {
    throw new VolareError(
      'invalid_request',
      'Responses request input must end with a user message',
    );
  }
  return {
    message: latest.content,
    conversationHistory: nonSystemMessages.slice(0, latestIndex),
    ...(systemInstructions ? { systemInstructions } : {}),
    attachments: latest.attachments,
  };
}

function isClientContextOnlyMessage(message: ParsedMessage): boolean {
  if (message.attachments.length > 0) {
    return false;
  }
  if (message.role === 'system' && isCodexHarnessInstructions(message.content)) {
    return true;
  }
  if (message.role !== 'user') {
    return false;
  }
  let remaining = message.content.trim();
  if (!remaining.startsWith('<')) {
    return false;
  }
  while (remaining.length > 0) {
    const match = remaining.match(/^<([a-z_]+)\b[\s\S]*?<\/\1>\s*/);
    if (!match) {
      return false;
    }
    const tag = match[1];
    if (!tag || !CLIENT_CONTEXT_ONLY_TAGS.has(tag)) {
      return false;
    }
    remaining = remaining.slice(match[0].length).trimStart();
  }
  return true;
}

function isCodexHarnessInstructions(content: string): boolean {
  const trimmed = content.trimStart();
  const codexPersonaHarness =
    trimmed.startsWith('You are a coding agent running in the Codex CLI') &&
    (trimmed.includes('# AGENTS.md spec') ||
      trimmed.includes('<skills_instructions>') ||
      trimmed.includes(
        'Within this context, Codex refers to the open-source agentic coding interface',
      ));
  const codexRuntimeHarness =
    trimmed.includes('<permissions instructions>') &&
    trimmed.includes('<skills_instructions>') &&
    trimmed.includes('### Available skills') &&
    trimmed.includes('Skill bodies live on disk');
  return codexPersonaHarness || codexRuntimeHarness;
}

function parseContent(content: unknown): { textParts: string[]; attachments: IAgentAttachment[] } {
  if (typeof content === 'string') {
    return { textParts: [content], attachments: [] };
  }
  if (!Array.isArray(content)) {
    return { textParts: [], attachments: [] };
  }

  const textParts: string[] = [];
  const attachments: IAgentAttachment[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      textParts.push(part);
      continue;
    }
    if (!isRecord(part)) {
      continue;
    }
    const text = typeof part['text'] === 'string' ? part['text'] : undefined;
    if (text !== undefined) {
      textParts.push(text);
    }
    const attachment = attachmentFromContentPart(part);
    if (attachment) {
      attachments.push(attachment);
    }
  }
  return { textParts, attachments };
}

function attachmentFromContentPart(part: Record<string, unknown>): IAgentAttachment | null {
  switch (part['type']) {
    case 'input_image': {
      const imageUrl = stringValue(part['image_url']) ?? urlFromObject(part['image_url']);
      const mediaType = mediaTypeFromDataUrl(imageUrl);
      const metadata = pickDefined({ detail: part['detail'] });
      return {
        kind: 'image',
        ...(imageUrl ? { uri: imageUrl } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(metadata ? { metadata } : {}),
      };
    }
    case 'input_file': {
      const fileUrl = stringValue(part['file_url']) ?? urlFromObject(part['file_url']);
      const fileId = stringValue(part['file_id']);
      const filename = stringValue(part['filename']);
      const fileData = stringValue(part['file_data']);
      const mediaType = mediaTypeFromDataUrl(fileData);
      const uri = fileUrl ?? fileId ?? fileData;
      const metadata = pickDefined({ file_id: fileId, has_file_data: fileData ? true : undefined });
      return {
        kind: 'file',
        ...(filename ? { name: filename } : {}),
        ...(uri ? { uri } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(metadata ? { metadata } : {}),
      };
    }
    default:
      return null;
  }
}

function urlFromObject(value: unknown): string | undefined {
  return isRecord(value) ? stringValue(value['url']) : undefined;
}

function mediaTypeFromDataUrl(value: string | undefined): string | undefined {
  const match = value?.match(/^data:([^;,]+)[;,]/);
  return match?.[1];
}

function pickDefined(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function metadataFromRequestBody(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const metadata = isRecord(body['metadata']) ? body['metadata'] : undefined;
  const clientMetadata = isRecord(body['client_metadata']) ? body['client_metadata'] : undefined;
  return mergeMetadata(metadata, clientMetadata);
}

function mergeMetadata(
  metadata: Record<string, unknown> | undefined,
  clientMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata && clientMetadata) {
    return { ...clientMetadata, ...metadata };
  }
  return metadata ?? clientMetadata;
}

function roleFromInputItem(item: Record<string, unknown>): 'user' | 'assistant' | 'system' {
  switch (item['role']) {
    case 'assistant':
      return 'assistant';
    case 'system':
    case 'developer':
      return 'system';
    default:
      return 'user';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toOpenAIStatus(status: ITurnRecord['status']): string {
  switch (status) {
    case 'queued':
    case 'running':
    case 'cancelling':
      return 'in_progress';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'interrupted':
      return 'incomplete';
  }
}

function failedEvent(events: AgentEvent[]): Extract<AgentEvent, { type: 'turn.failed' }> | null {
  return (
    events.find(
      (event): event is Extract<AgentEvent, { type: 'turn.failed' }> =>
        event.type === 'turn.failed',
    ) ?? null
  );
}

function errorFromEvents(events: AgentEvent[]): { code: string; message: string } | null {
  const event = failedEvent(events);
  return event ? toResponseError(event.error) : null;
}

function toResponseError(error: unknown): { code: string; message: string } {
  if (error instanceof VolareError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'internal_error', message: error.message };
  }
  if (isRecord(error)) {
    const code = stringValue(error['code']) ?? 'internal_error';
    const message = stringValue(error['message']) ?? JSON.stringify(error);
    return { code, message };
  }
  if (typeof error === 'string') {
    return { code: 'internal_error', message: error };
  }
  return { code: 'internal_error', message: 'Unexpected failure' };
}

function incompleteDetailsFromEvents(events: AgentEvent[]): { reason: string } | null {
  const terminal = events.find(
    (
      event,
    ): event is
      | Extract<AgentEvent, { type: 'turn.cancelled' }>
      | Extract<AgentEvent, { type: 'turn.interrupted' }> =>
      event.type === 'turn.cancelled' || event.type === 'turn.interrupted',
  );
  return terminal ? { reason: incompleteReason(terminal) } : null;
}

function metadataFromEvents(events: AgentEvent[]): Record<string, unknown> | null {
  const created = events.find(
    (event): event is Extract<AgentEvent, { type: 'turn.created' }> =>
      event.type === 'turn.created',
  );
  return created?.requestMetadata ?? null;
}

function incompleteReason(
  event:
    | Extract<AgentEvent, { type: 'turn.cancelled' }>
    | Extract<AgentEvent, { type: 'turn.interrupted' }>,
): string {
  if (event.type === 'turn.interrupted') {
    return event.reason;
  }
  return 'cancelled';
}

function usageFromEvents(events: AgentEvent[], outputText: string): unknown {
  const succeeded = events.find(
    (event): event is Extract<AgentEvent, { type: 'turn.succeeded' }> =>
      event.type === 'turn.succeeded',
  );
  return succeeded?.usage
    ? toResponsesUsage(succeeded.usage)
    : toResponsesUsage(createEstimatedUsageFromTokens(0, estimateTextTokens(outputText)));
}

function usageForStream(
  event:
    | Extract<AgentEvent, { type: 'turn.succeeded' }>
    | Extract<AgentEvent, { type: 'turn.failed' }>
    | Extract<AgentEvent, { type: 'turn.cancelled' }>
    | Extract<AgentEvent, { type: 'turn.interrupted' }>,
  context: IResponseContext,
  outputText: string,
): unknown {
  if (event.type === 'turn.succeeded' && event.usage) {
    return toResponsesUsage(event.usage);
  }
  return toResponsesUsage(
    createEstimatedUsageFromTokens(
      context.requestInput ? estimateAgentInputTokens(context.requestInput) : 0,
      estimateTextTokens(outputText),
    ),
  );
}

function toResponsesUsage(usage: IAgentUsage): unknown {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function statusForErrorCode(code: string): number {
  switch (code) {
    case 'invalid_request':
    case 'unsupported_parameter':
      return 400;
    case 'unauthorized':
      return 401;
    case 'workspace_forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'backend_session_mismatch':
    case 'session_lost':
    case 'workspace_changed':
      return 409;
    default:
      return 500;
  }
}
