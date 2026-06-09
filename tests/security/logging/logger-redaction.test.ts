import { describe, expect, test } from 'bun:test';
import type { DestinationStream } from 'pino';

import { createLogger } from '../../../src/logging/logger';

class MemoryDestination implements DestinationStream {
  readonly lines: string[] = [];

  write(chunk: string): boolean {
    this.lines.push(chunk);
    return true;
  }
}

describe('structured logger redaction', () => {
  test('redacts sensitive request fields before writing log output', () => {
    const destination = new MemoryDestination();
    const logger = createLogger({ destination });

    logger.warn(
      {
        authorization: 'Bearer secret',
        headers: { authorization: 'Bearer secret' },
        apiKey: 'secret',
        prompt: 'secret prompt',
      },
      'sensitive fields',
    );

    const text = destination.lines.join('\n');
    expect(text).not.toContain('Bearer secret');
    expect(text).not.toContain('secret prompt');
    const entry = JSON.parse(destination.lines[0] ?? '{}') as {
      authorization?: unknown;
      headers?: { authorization?: unknown };
      apiKey?: unknown;
      prompt?: unknown;
    };
    expect(entry.authorization).toBe('[Redacted]');
    expect(entry.headers?.authorization).toBe('[Redacted]');
    expect(entry.apiKey).toBe('[Redacted]');
    expect(entry.prompt).toBe('[Redacted]');
  });
});
