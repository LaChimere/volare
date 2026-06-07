import { evaluateAnswerGrounding, type IRequestGroundingHint } from '../core/grounding';
import type { AgentEvent } from '../core/types';

export interface ITurnMetrics {
  turns_total: number;
  turns_with_zero_tools_total: number;
  turns_with_sources_total: number;
  turns_with_citation_like_output_total: number;
  turns_with_grounding_warnings_total: number;
  turns_unmediated_total: number;
}

export function createTurnMetrics(): ITurnMetrics {
  return {
    turns_total: 0,
    turns_with_zero_tools_total: 0,
    turns_with_sources_total: 0,
    turns_with_citation_like_output_total: 0,
    turns_with_grounding_warnings_total: 0,
    turns_unmediated_total: 0,
  };
}

export async function* observeLiveTurnMetrics(
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

export function recordAcceptedTurnMetrics(
  metrics: ITurnMetrics,
  unmediatedToolingEnabled: boolean,
): void {
  metrics.turns_total += 1;
  if (unmediatedToolingEnabled) {
    metrics.turns_unmediated_total += 1;
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
