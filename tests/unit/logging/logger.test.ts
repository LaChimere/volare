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

describe('structured logger', () => {
  test('emits JSON logs with level, bindings, and messages', () => {
    const destination = new MemoryDestination();
    const logger = createLogger({
      level: 'debug',
      bindings: { component: 'test' },
      destination,
    }).child({ requestId: 'request_1' });

    logger.info({ status: 200, durationMs: 12 }, 'request completed');

    const entry = JSON.parse(destination.lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry['level']).toBe('info');
    expect(entry['service']).toBe('volare');
    expect(entry['component']).toBe('test');
    expect(entry['requestId']).toBe('request_1');
    expect(entry['status']).toBe(200);
    expect(entry['durationMs']).toBe(12);
    expect(entry['msg']).toBe('request completed');
    expect(typeof entry['time']).toBe('string');
  });

  test('redacts sensitive fields before writing', () => {
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
