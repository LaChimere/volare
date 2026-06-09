import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ICopilotPromptRunner,
  ICopilotPromptRunOptions,
} from '../../../src/backends/copilot-cli/backend';

export { collectEvents } from '../agent-events';
export { CapturingLogger } from '../capturing-logger';

export class FakeCopilotPromptRunner implements ICopilotPromptRunner {
  lastOptions?: ICopilotPromptRunOptions;
  lastPrompt?: string;
  readonly cancelled: Array<{ backendSessionId: string; forceAfterTimeout?: boolean }> = [];
  readonly disposed: string[] = [];

  constructor(
    readonly chunks?: string[],
    readonly errorAfterChunks?: unknown,
  ) {}

  async *run(prompt: string, options: ICopilotPromptRunOptions): AsyncIterable<string> {
    this.lastPrompt = prompt;
    this.lastOptions = options;
    for (const chunk of this.chunks ?? [`copilot:${prompt}`]) {
      yield chunk;
    }
    if (this.errorAfterChunks) {
      throw this.errorAfterChunks;
    }
  }

  async cancel(backendSessionId: string, options = { timeoutMs: 0, forceAfterTimeout: false }) {
    this.cancelled.push({ backendSessionId, forceAfterTimeout: options.forceAfterTimeout });
    return { status: options.forceAfterTimeout ? 'timed_out' : 'cancelled' } as const;
  }

  async dispose(backendSessionId: string) {
    this.disposed.push(backendSessionId);
  }
}

export async function installFakeCopilot(name: string, source: string): Promise<string> {
  const root = await mkdtemp(path.join(import.meta.dir, `fake-copilot-${name}-`));
  const bin = path.join(root, 'copilot');
  await writeFile(bin, source);
  await chmod(bin, 0o755);
  return bin;
}

export async function readArgvFile(filePath: string): Promise<string[]> {
  return (await readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean);
}
