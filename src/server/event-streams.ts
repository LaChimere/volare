import type { AgentEvent, IEventJournal } from '../core/types';

export async function* journalCanonicalEvents(
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

export async function collectAgentEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
