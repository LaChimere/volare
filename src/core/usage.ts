import type { IAgentInput, IAgentUsage } from './types';

const textEncoder = new TextEncoder();

export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const nonAsciiCodePoints = [...text].filter((char) => {
    const codePoint = char.codePointAt(0);
    return codePoint !== undefined && codePoint > 0x7f;
  }).length;
  return Math.max(1, Math.ceil((textEncoder.encode(text).length + nonAsciiCodePoints) / 4));
}

export function estimateAgentInputTokens(input: IAgentInput): number {
  const sections: string[] = [];
  if (input.systemInstructions) {
    sections.push(input.systemInstructions);
  }
  for (const message of input.conversationHistory ?? []) {
    sections.push(`${message.role}: ${message.content}`);
  }
  sections.push(input.message);
  return estimateTextTokens(sections.join('\n\n'));
}

export function createEstimatedUsage(inputText: string, outputText: string): IAgentUsage {
  return createEstimatedUsageFromTokens(
    estimateTextTokens(inputText),
    estimateTextTokens(outputText),
  );
}

export function createEstimatedUsageFromTokens(
  inputTokens: number,
  outputTokens: number,
): IAgentUsage {
  assertTokenCount(inputTokens, 'inputTokens');
  assertTokenCount(outputTokens, 'outputTokens');
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
    source: 'agent-loom-heuristic',
  };
}

function assertTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
