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
    if (Array.isArray(tools) && tools.length > 0) {
      throw new AgentLoomError(
        'unsupported_parameter',
        'Client-side tools are not supported in the MVP',
      );
    }

    const model = stringValue(request.body['model']);
    if (!model) {
      throw new AgentLoomError('invalid_request', 'Responses request requires a model');
    }

    const message = inputToMessage(request.body['input']);
    if (!message) {
      throw new AgentLoomError('invalid_request', 'Responses request requires text input');
    }

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
      input: { message },
      ...(metadata ? { metadata } : {}),
      clientRef: {
        externalId: createId('resp'),
        ...(previousResponseId ? { parentExternalId: previousResponseId } : {}),
      },
    };
  }

  async *encodeStream(
    events: AsyncIterable<AgentEvent>,
    context: ResponseContextInterface,
  ): AsyncIterable<Uint8Array> {
    const responseId = context.externalResponseId ?? context.turnId;
    let sequenceNumber = 0;

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
      switch (event.type) {
        case 'turn.created':
          break;
        case 'text.delta':
          yield encodeSse({
            type: 'response.output_text.delta',
            sequence_number: sequenceNumber++,
            item_id: `msg_${responseId}`,
            output_index: 0,
            content_index: 0,
            delta: event.delta,
          });
          break;
        case 'turn.succeeded':
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
              [event],
            ),
          });
          break;
        case 'turn.failed':
          yield encodeSse({
            type: 'response.failed',
            sequence_number: sequenceNumber++,
            response: { id: responseId, status: 'failed', error: event.error },
          });
          break;
        case 'turn.cancelled':
        case 'turn.interrupted':
          yield encodeSse({
            type: 'response.incomplete',
            sequence_number: sequenceNumber++,
            response: { id: responseId, status: 'incomplete' },
          });
          break;
        default:
          break;
      }
    }

    yield encoder.encode('data: [DONE]\n\n');
  }

  encodeStoredResponse(record: TurnRecordInterface, events: AgentEvent[]): unknown {
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
      error: failedEvent(events)?.error ?? null,
      previous_response_id: null,
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
      cancellation: false,
    };
  }
}

export function encodeOpenAIError(error: unknown): Response {
  const agentError = toAgentLoomError(error);
  const status = statusForErrorCode(agentError.code);
  return Response.json(new OpenAIResponsesAdapter().encodeError(agentError), { status });
}

function encodeSse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function inputToMessage(input: unknown): string | null {
  if (typeof input === 'string') {
    return input;
  }
  if (!Array.isArray(input)) {
    return null;
  }

  const parts = input.flatMap((item) => {
    if (typeof item === 'string') {
      return [item];
    }
    if (!isRecord(item)) {
      return [];
    }
    return contentToParts(item['content']);
  });
  const message = parts.join('\n').trim();
  return message.length > 0 ? message : null;
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
