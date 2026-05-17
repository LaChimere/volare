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

  test('strips URL userinfo and summarizes unsafe URL forms', () => {
    const redactor = new DefaultRedactor();

    expect(
      redactor.redact({
        direct: {
          url: 'https://user:pass@example.test/path?token=secret#fragment',
          uri: 'https://user%3Apass%40example.test/path',
        },
        unsupported: {
          file: { url: 'file:///Users/alice/secret.txt' },
          data: { url: 'data:text/plain,secret' },
          javascript: { url: 'javascript:alert(secret)' },
          blob: { url: 'blob:https://example.test/secret' },
          vbscript: { url: 'vbscript:msgbox(secret)' },
        },
        injection: {
          url: 'https://example.test/path\r\nx-secret: value',
        },
        long: {
          url: `https://example.test/${'a'.repeat(2100)}?token=secret`,
        },
      }),
    ).toEqual({
      value: {
        direct: {
          url: 'https://example.test/path',
          uri: '[redacted-url:encoded-userinfo]',
        },
        unsupported: {
          file: { url: '[redacted-url:scheme=file]' },
          data: { url: '[redacted-url:scheme=data]' },
          javascript: { url: '[redacted-url:scheme=javascript]' },
          blob: { url: '[redacted-url:scheme=blob]' },
          vbscript: { url: '[redacted-url:scheme=vbscript]' },
        },
        injection: {
          url: '[redacted-url:invalid-control]',
        },
        long: {
          url: '[redacted-url:scheme=https,host=example.test,byteCount=2134]',
        },
      },
      redactionJson: {
        redactedPaths: [
          '$.direct.url',
          '$.direct.uri',
          '$.unsupported.file.url',
          '$.unsupported.data.url',
          '$.unsupported.javascript.url',
          '$.unsupported.blob.url',
          '$.unsupported.vbscript.url',
          '$.injection.url',
          '$.long.url',
        ],
      },
    });
  });
});
