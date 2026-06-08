import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { extractTextFromCopilotOutput } from '../../../src/backends/copilot-cli/backend';
import { type IRedactor, RedactionFailedError } from '../../../src/events/redaction';
import {
  assertCopilotFrameFixtureIsSafe,
  COPILOT_FRAME_FORBIDDEN_PATTERNS,
  writeRedactedCopilotFrameFixture,
} from '../../support/copilot-frame-fixtures';

const fixtureDir = path.join(import.meta.dir, '../../fixtures/copilot-cli');

describe('Copilot CLI frame fixtures', () => {
  test('keeps text-only fixture as answer text', async () => {
    const content = await Bun.file(path.join(fixtureDir, 'text-only.jsonl')).text();

    assertCopilotFrameFixtureIsSafe(content);
    expect(extractTextFromCopilotOutput(content)).toBe('hello world');
  });

  test('does not emit unknown unmediated MCP frames as answer text', async () => {
    const content = await Bun.file(path.join(fixtureDir, 'unmediated-mcp.jsonl')).text();

    assertCopilotFrameFixtureIsSafe(content);
    expect(extractTextFromCopilotOutput(content)).toBe('done');
  });

  test('redacts poisoned fixture input before writing', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-fixture-'));
    const fixturePath = path.join(root, 'poisoned.jsonl');
    try {
      await writeRedactedCopilotFrameFixture(fixturePath, [
        {
          type: 'tool.result',
          data: {
            headers: { authorization: 'Bearer secret-token-value' },
            url: 'https://user:pass@example.test/path?X-Amz-Signature=abc&sig=def',
            token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
            apiKey: 'AKIA1234567890ABCDEF',
            secret: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
            fileContents: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
          },
        },
      ]);

      const content = await Bun.file(fixturePath).text();
      for (const { pattern } of COPILOT_FRAME_FORBIDDEN_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
      expect(content).toContain('"redacted":true');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not reject safe HTTP URL paths that resemble filesystem roots', () => {
    expect(() =>
      assertCopilotFrameFixtureIsSafe(
        '{"type":"tool.result","data":{"url":"https://example.com/Users/public"}}\n',
      ),
    ).not.toThrow();
  });

  test('deletes candidate fixture when redaction or post-write safety checks fail', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-fixture-'));
    const unsafePath = path.join(root, 'unsafe.jsonl');
    const failedRedactionPath = path.join(root, 'failed-redaction.jsonl');
    const throwingRedactor: IRedactor = {
      redact() {
        throw new RedactionFailedError('test', new Error('boom'));
      },
    };
    try {
      await expect(
        writeRedactedCopilotFrameFixture(unsafePath, [
          { type: 'tool.result', data: { path: '/Users/example/secret.txt' } },
        ]),
      ).rejects.toThrow('forbidden absolute_path pattern');
      await expect(Bun.file(unsafePath).exists()).resolves.toBe(false);

      await expect(
        writeRedactedCopilotFrameFixture(
          failedRedactionPath,
          [{ type: 'assistant.message_delta', data: { deltaContent: 'hello' } }],
          { redactor: throwingRedactor },
        ),
      ).rejects.toThrow('Redaction failed before journal persistence');
      await expect(Bun.file(failedRedactionPath).exists()).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
