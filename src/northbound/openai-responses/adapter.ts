import { AgentLoomError, toAgentLoomError } from '../../core/errors';
import { createId } from '../../core/ids';
import type {
  AgentEvent,
  AgentLoomErrorInterface,
  AgentRequestInputInterface,
  NorthboundAdapterInterface,
  NorthboundCapabilitiesInterface,
  NorthboundRequestInterface,
  RequestContextInterface,
  ResponseContextInterface,
  StateStoreInterface,
  TurnRecordInterface,
  WorkspaceHintsInterface,
} from '../../core/types';

const encoder = new TextEncoder();
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
};

export class OpenAIResponsesAdapter implements NorthboundAdapterInterface {
  readonly protocol = 'openai-responses-v1';

  constructor(readonly stateStore?: StateStoreInterface) {}

  async extractWorkspaceHints(
    request: NorthboundRequestInterface,
  ): Promise<WorkspaceHintsInterface> {
    const metadata = isRecord(request.body) ? request.body['metadata'] : undefined;
    const requestedRoot = isRecord(metadata) ? stringValue(metadata['workspace_root']) : undefined;
    if (requestedRoot) {
      return { source: 'client-metadata', requestedRoot };
    }
    return { source: 'process-cwd' };
  }

  async parseRequest(
    request: NorthboundRequestInterface,
    _context: RequestContextInterface,
  ): Promise<AgentRequestInputInterface> {
    if (!isRecord(request.body)) {
      throw new AgentLoomError('invalid_request', 'Responses request body must be a JSON object');
    }

    const tools = request.body['tools'];
    if (tools !== undefined && !Array.isArray(tools)) {
      throw new AgentLoomError('invalid_request', 'Responses request tools must be an array');
    }

    const model = stringValue(request.body['model']);
    if (!model) {
      throw new AgentLoomError('invalid_request', 'Responses request requires a model');
    }

    const parsedInput = parseInput(request.body['input']);
    if (!parsedInput) {
      throw new AgentLoomError('invalid_request', 'Responses request requires text input');
    }
    const systemInstructions = [
      stringValue(request.body['instructions']),
      parsedInput.systemInstructions,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n\n');

    const previousResponseId = stringValue(request.body['previous_response_id']);
    const parentRef = previousResponseId
      ? await this.stateStore?.resolveClientRef(this.protocol, previousResponseId)
      : null;
    if (previousResponseId && this.stateStore && !parentRef) {
      throw new AgentLoomError('not_found', 'previous_response_id was not found');
    }
    const metadata = isRecord(request.body['metadata']) ? request.body['metadata'] : undefined;
    return {
      ...(parentRef ? { threadId: parentRef.threadId, parentTurnId: parentRef.turnId } : {}),
      model,
      input: {
        message: parsedInput.message,
        ...(parsedInput.conversationHistory.length > 0
          ? { conversationHistory: parsedInput.conversationHistory }
          : {}),
        ...(systemInstructions ? { systemInstructions } : {}),
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
    context: ResponseContextInterface,
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
                parentTurnId: null,
                bridgeSessionId: '',
                status: 'succeeded',
                model: '',
                createdAt: new Date(),
                completedAt: new Date(),
              },
              replayedEvents,
              { previousResponseId: context.previousResponseId ?? null },
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
              usage: ZERO_USAGE,
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
              usage: ZERO_USAGE,
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
    record: TurnRecordInterface,
    events: AgentEvent[],
    options: { previousResponseId?: string | null } = {},
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
      usage: usageFromEvents(events),
      previous_response_id: options.previousResponseId ?? null,
    };
  }

  encodeError(error: AgentLoomErrorInterface): unknown {
    return {
      error: {
        type: error.code,
        message: error.message,
      },
    };
  }

  capabilities(): NorthboundCapabilitiesInterface {
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
        slug: 'copilot-agent',
        display_name: 'Copilot Agent',
        description: 'Agent Loom bridge to a Copilot-backed local agent runtime.',
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
  const agentError = toAgentLoomError(error);
  const status = statusForErrorCode(agentError.code);
  return Response.json(new OpenAIResponsesAdapter().encodeError(agentError), { status });
}

function encodeSse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

interface ParsedInputInterface {
  message: string;
  conversationHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  systemInstructions?: string;
}

function parseInput(input: unknown): ParsedInputInterface | null {
  if (typeof input === 'string') {
    const message = input.trim();
    return message ? { message, conversationHistory: [] } : null;
  }
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.every((item) => typeof item === 'string')) {
    const message = input.join('\n').trim();
    return message ? { message, conversationHistory: [] } : null;
  }

  const messages = input.flatMap((item) => {
    if (typeof item === 'string') {
      const content = item.trim();
      return content ? [{ role: 'user' as const, content }] : [];
    }
    if (!isRecord(item)) {
      return [];
    }
    const content = contentToParts(item['content']).join('\n').trim();
    if (!content) {
      return [];
    }
    return [{ role: roleFromInputItem(item), content }];
  });
  const systemInstructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const nonSystemMessages = messages.filter((message) => message.role !== 'system');
  const latestIndex = nonSystemMessages.length - 1;
  const latest = nonSystemMessages[latestIndex];
  if (!latest) {
    return null;
  }
  if (latest.role !== 'user') {
    throw new AgentLoomError(
      'invalid_request',
      'Responses request input must end with a user message',
    );
  }
  return {
    message: latest.content,
    conversationHistory: nonSystemMessages.slice(0, latestIndex),
    ...(systemInstructions ? { systemInstructions } : {}),
  };
}

function contentToParts(content: unknown): string[] {
  if (typeof content === 'string') {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (typeof part === 'string') {
      return [part];
    }
    if (!isRecord(part)) {
      return [];
    }
    return typeof part['text'] === 'string' ? [part['text']] : [];
  });
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

function toOpenAIStatus(status: TurnRecordInterface['status']): string {
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
  if (error instanceof AgentLoomError) {
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

function usageFromEvents(events: AgentEvent[]): unknown {
  const succeeded = events.find(
    (event): event is Extract<AgentEvent, { type: 'turn.succeeded' }> =>
      event.type === 'turn.succeeded',
  );
  return succeeded?.usage ?? ZERO_USAGE;
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
