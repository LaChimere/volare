import { describe, expect, test } from 'bun:test';

import { DefaultRedactor } from '../../../src/events/redaction';

describe('DefaultRedactor', () => {
  test('redacts sensitive headers while preserving safe headers', () => {
    const redactor = new DefaultRedactor();

    expect(
      redactor.redact({
        headers: {
          Authorization: 'Bearer secret',
          Cookie: 'session=secret',
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
      }),
    ).toEqual({
      value: {
        headers: {
          Authorization: { redacted: true, charCount: 13 },
          Cookie: { redacted: true, charCount: 14 },
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
      },
      redactionJson: {
        redactedPaths: ['$.headers.Authorization', '$.headers.Cookie'],
      },
    });
  });

  test('summarizes commands, urls, environment variables, prompts, and file contents', () => {
    const redactor = new DefaultRedactor();

    expect(
      redactor.redact({
        action: 'shell:exec',
        scope: {
          command: 'git commit -m secret',
          url: 'https://example.test/path?token=secret#fragment',
        },
        env: {
          NODE_ENV: 'test',
          API_TOKEN: 'secret',
        },
        prompt: 'please do secret work',
        fileContents: 'secret file contents',
      }),
    ).toEqual({
      value: {
        action: 'shell:exec',
        scope: {
          command: { redacted: true, commandName: 'git', argumentCount: 3 },
          url: 'https://example.test/path',
        },
        env: {
          NODE_ENV: 'test',
          API_TOKEN: { redacted: true, charCount: 6 },
        },
        prompt: { redacted: true, charCount: 21 },
        fileContents: { redacted: true, byteCount: 20 },
      },
      redactionJson: {
        redactedPaths: [
          '$.scope.command',
          '$.scope.url',
          '$.env.API_TOKEN',
          '$.prompt',
          '$.fileContents',
        ],
      },
    });
  });
});
