import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DefaultRedactor, type IRedactor } from '../../src/events/redaction';

export interface IForbiddenFixturePattern {
  name: string;
  pattern: RegExp;
}

export const COPILOT_FRAME_FORBIDDEN_PATTERNS: IForbiddenFixturePattern[] = [
  {
    name: 'absolute_path',
    pattern: /(?::\s*"|^\s*"|[\[,]\s*")\/(?:Users|home|tmp|private|var|etc|opt|Volumes)\//,
  },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/i },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'github_token', pattern: /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/ },
  { name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'signed_url_signature', pattern: /(?:X-Amz-Signature=|[?&]sig=)[^"&\s]+/i },
  { name: 'url_userinfo', pattern: /https?:\/\/[^/\s:@]+:[^/\s@]+@/i },
];

export async function writeRedactedCopilotFrameFixture(
  path: string,
  frames: unknown[],
  options: { redactor?: IRedactor } = {},
): Promise<void> {
  const redactor = options.redactor ?? new DefaultRedactor();
  try {
    const redactedFrames = frames.map((frame) => redactor.redact(frame).value);
    const content = `${redactedFrames.map((frame) => JSON.stringify(frame)).join('\n')}\n`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    assertCopilotFrameFixtureIsSafe(content);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export function assertCopilotFrameFixtureIsSafe(content: string): void {
  const match = COPILOT_FRAME_FORBIDDEN_PATTERNS.find(({ pattern }) => pattern.test(content));
  if (match) {
    throw new Error(`Copilot frame fixture contains forbidden ${match.name} pattern`);
  }
}
