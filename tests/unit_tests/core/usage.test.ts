import { describe, expect, test } from 'bun:test';

import {
  createEstimatedUsage,
  createEstimatedUsageFromTokens,
  estimateAgentInputTokens,
  estimateTextTokens,
} from '../../../src/core/usage';

describe('usage estimation', () => {
  test('estimates ASCII and non-ASCII text tokens conservatively', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('hello')).toBe(2);
    expect(estimateTextTokens('你好')).toBe(2);
  });

  test('estimates agent input from system, history, and latest message text', () => {
    expect(
      estimateAgentInputTokens({
        systemInstructions: 'Be brief.',
        conversationHistory: [{ role: 'assistant', content: 'Prior answer.' }],
        message: 'Follow up?',
      }),
    ).toBeGreaterThan(0);
  });

  test('creates explicit estimated usage metadata for internal events', () => {
    expect(createEstimatedUsage('hello', 'world')).toMatchObject({
      inputTokens: 2,
      outputTokens: 2,
      totalTokens: 4,
      estimated: true,
      source: 'agent-loom-heuristic',
    });
  });

  test('rejects invalid token counts', () => {
    expect(() => createEstimatedUsageFromTokens(-1, 1)).toThrow(
      'inputTokens must be a non-negative safe integer',
    );
    expect(() => createEstimatedUsageFromTokens(1.5, 1)).toThrow(
      'inputTokens must be a non-negative safe integer',
    );
    expect(() => createEstimatedUsageFromTokens(1, Number.NaN)).toThrow(
      'outputTokens must be a non-negative safe integer',
    );
  });
});
