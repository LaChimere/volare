import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ICopilotPromptRunner,
  ICopilotPromptRunOptions,
} from '../../../src/backends/copilot-cli/backend';
import type { AgentEvent } from '../../../src/core/types';
import type { ILogBindings, ILogFields, ILogger } from '../../../src/logging/logger';

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

export class CapturingLogger implements ILogger {
  constructor(
    readonly entries: Array<{ level: string; fields: ILogFields; message?: string }> = [],
    readonly bindings: ILogBindings = {},
  ) {}

  child(bindings: ILogBindings): ILogger {
    return new CapturingLogger(this.entries, { ...this.bindings, ...bindings });
  }

  trace(fields: ILogFields, message?: string): void {
    this.push('trace', fields, message);
  }

  debug(fields: ILogFields, message?: string): void {
    this.push('debug', fields, message);
  }

  info(fields: ILogFields, message?: string): void {
    this.push('info', fields, message);
  }

  warn(fields: ILogFields, message?: string): void {
    this.push('warn', fields, message);
  }

  error(fields: ILogFields, message?: string): void {
    this.push('error', fields, message);
  }

  fatal(fields: ILogFields, message?: string): void {
    this.push('fatal', fields, message);
  }

  private push(level: string, fields: ILogFields, message?: string): void {
    this.entries.push({
      level,
      fields: { ...this.bindings, ...fields },
      ...(message === undefined ? {} : { message }),
    });
  }
}

export async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
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
