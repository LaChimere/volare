import { VolareError } from '../core/errors';
import type { IEventJournal, ISessionManager, IStateStore } from '../core/types';
import {
  encodeOpenAIError,
  type OpenAIResponsesAdapter,
} from '../northbound/openai-responses/adapter';
import { collectAgentEvents } from './event-streams';

export async function handleStoredOpenAIResponse(input: {
  responseId: string;
  adapter: OpenAIResponsesAdapter;
  sessionManager: ISessionManager | undefined;
  stateStore: IStateStore | undefined;
  eventJournal: IEventJournal | undefined;
}): Promise<Response> {
  if (!input.sessionManager) {
    return encodeOpenAIError(new VolareError('not_found', 'Response not found'));
  }
  const clientRef = await input.stateStore?.resolveClientRef(
    input.adapter.protocol,
    input.responseId,
  );
  if (input.stateStore && !clientRef) {
    return encodeOpenAIError(new VolareError('not_found', 'Response not found'));
  }
  const turnId = clientRef?.turnId ?? input.responseId;
  const turn = await input.sessionManager.getTurn(turnId);
  if (!turn) {
    return encodeOpenAIError(new VolareError('not_found', 'Response not found'));
  }
  let events = input.sessionManager.getEvents(turn.id);
  if (events.length === 0 && input.eventJournal) {
    events = await collectAgentEvents(input.eventJournal.replay(turn.id));
  }
  return Response.json(
    input.adapter.encodeStoredResponse(
      clientRef ? { ...turn, id: clientRef.externalId } : turn,
      events,
      {
        previousResponseId: clientRef?.parentExternalId ?? null,
      },
    ),
  );
}

export async function handleCancelOpenAIResponse(input: {
  responseId: string;
  adapter: OpenAIResponsesAdapter;
  sessionManager: ISessionManager | undefined;
  stateStore: IStateStore | undefined;
  eventJournal: IEventJournal | undefined;
}): Promise<Response> {
  if (!input.sessionManager) {
    return encodeOpenAIError(new VolareError('not_found', 'Response not found'));
  }
  const clientRef = await input.stateStore?.resolveClientRef(
    input.adapter.protocol,
    input.responseId,
  );
  if (input.stateStore && !clientRef) {
    return encodeOpenAIError(new VolareError('not_found', 'Response not found'));
  }
  const turnId = clientRef?.turnId ?? input.responseId;
  const result = await input.sessionManager.cancelTurn(turnId);
  if (result.status === 'not_found') {
    return encodeOpenAIError(new VolareError('not_found', 'Response not found'));
  }
  const turn = await input.sessionManager.getTurn(turnId);
  if (!turn) {
    return encodeOpenAIError(new VolareError('not_found', 'Response not found'));
  }
  let events = input.sessionManager.getEvents(turn.id);
  if (events.length === 0 && input.eventJournal) {
    events = await collectAgentEvents(input.eventJournal.replay(turn.id));
  }
  return Response.json(
    input.adapter.encodeStoredResponse(
      clientRef ? { ...turn, id: clientRef.externalId } : turn,
      events,
      { previousResponseId: clientRef?.parentExternalId ?? null },
    ),
  );
}
