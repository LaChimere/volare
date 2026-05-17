import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BunCopilotPromptRunner,
  CopilotCliBackend,
  DEFAULT_COPILOT_CLI_PERMISSION_MODE,
  extractTextFromCopilotOutput,
  type ICopilotPromptRunner,
  type ICopilotPromptRunOptions,
} from '../../../src/backends/copilot-cli/backend';
import { VolareError } from '../../../src/core/errors';
import type { AgentEvent, IWorkspace } from '../../../src/core/types';
import type { ILogBindings, ILogFields, ILogger } from '../../../src/logging/logger';

class FakeCopilotPromptRunner implements ICopilotPromptRunner {
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

class CapturingLogger implements ILogger {
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

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('CopilotCliBackend', () => {
  test('uses Phase 0 backend-internal approval capability metadata', () => {
    const backend = new CopilotCliBackend({ runner: new FakeCopilotPromptRunner() });

    expect(backend.capabilities()).toEqual({
      persistentSessions: false,
      serverSideTools: true,
      permissionRequests: true,
      externalApprovalDecisions: false,
      backendInternalPauseResume: true,
      cancellation: true,
    });
  });

  test('streams text through the configured runner', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner();
    const backend = new CopilotCliBackend({ runner });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      const events = await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: { message: 'hello' },
          model: 'copilot-agent',
        }),
      );

      expect(events[0]).toMatchObject({
        type: 'text.delta',
        turnId: 'turn_1',
        delta: expect.stringContaining('User request:\nhello'),
      });
      expect(events[1]).toMatchObject({
        type: 'turn.succeeded',
        turnId: 'turn_1',
        output: { text: expect.stringContaining('User request:\nhello') },
        usage: {
          estimated: true,
        },
      });
      expect(
        (events[1] as Extract<AgentEvent, { type: 'turn.succeeded' }>).usage?.inputTokens,
      ).toBeGreaterThan(5);
      expect(runner.lastOptions).toMatchObject({
        backendSessionId: session.backendSessionId,
        cwd: workspace.rootPath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('logs backend completion summary metrics without exact prompt content', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner(['hello', ' world']);
    const logger = new CapturingLogger();
    const backend = new CopilotCliBackend({ runner, logger });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: {
            message: 'hello',
            conversationHistory: [{ role: 'user', content: 'earlier' }],
          },
          model: 'copilot-agent',
        }),
      );

      const completed = logger.entries.find(
        (entry) => entry.fields['event'] === 'backend.turn.completed',
      );
      expect(completed?.fields).toMatchObject({
        component: 'backend',
        backend: 'copilot-cli',
        event: 'backend.turn.completed',
        outputChars: 11,
        groundingDomain: 'general',
        needsSourceGrounding: false,
        groundingCitationLikeOutputCount: 0,
        groundingMarkdownHttpLinkCount: 0,
        groundingBareHttpUrlCount: 0,
        groundingBracketReferenceCount: 0,
        groundingEvaluatedByteCount: 11,
        groundingTruncated: false,
        groundingWarningCodes: [],
        unmediatedToolingEnabled: false,
        deltaCount: 2,
        historyMessagesBucket: '1-5',
      });
      for (const field of [
        'durationMs',
        'promptAssembleMs',
        'firstAssistantDeltaMs',
        'maxObservedInterDeltaGapMs',
      ]) {
        expect(typeof completed?.fields[field]).toBe('number');
      }
      expect(typeof completed?.fields['promptSizeBucket']).toBe('string');
      expect(JSON.stringify(completed)).not.toContain('earlier');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('logs backend completion metrics when no assistant delta is emitted', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const logger = new CapturingLogger();
    const backend = new CopilotCliBackend({
      runner: new FakeCopilotPromptRunner([]),
      logger,
    });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: { message: 'hello' },
          model: 'copilot-agent',
        }),
      );

      const completed = logger.entries.find(
        (entry) => entry.fields['event'] === 'backend.turn.completed',
      );
      expect(completed?.fields).toMatchObject({
        outputChars: 0,
        deltaCount: 0,
        historyMessagesBucket: '0',
      });
      expect(completed?.fields['firstAssistantDeltaMs']).toBeUndefined();
      expect(completed?.fields['maxObservedInterDeltaGapMs']).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('logs backend failure summaries with safe failure classes', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const logger = new CapturingLogger();
    const backend = new CopilotCliBackend({
      runner: new FakeCopilotPromptRunner(
        ['partial'],
        new VolareError('backend_stream_failed', 'raw stream failure'),
      ),
      logger,
    });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      await expect(
        collectEvents(
          backend.send(session, {
            turnId: 'turn_1',
            threadId: 'thread_1',
            workspaceId: 'workspace_1',
            input: { message: 'hello' },
            model: 'copilot-agent',
          }),
        ),
      ).rejects.toThrow('raw stream failure');

      const failed = logger.entries.find(
        (entry) => entry.fields['event'] === 'backend.turn.failed',
      );
      expect(failed?.fields).toMatchObject({
        event: 'backend.turn.failed',
        outputChars: 7,
        deltaCount: 1,
        failureClass: 'stream_read_failure',
        errorCode: 'backend_stream_failed',
      });
      expect(failed?.fields['error']).toBeUndefined();
      expect(JSON.stringify(logger.entries)).not.toContain('raw stream failure');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('classifies Copilot process exits separately from stream failures', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const logger = new CapturingLogger();
    const backend = new CopilotCliBackend({
      runner: new FakeCopilotPromptRunner(
        [],
        new VolareError('backend_process_failed', 'raw process failure'),
      ),
      logger,
    });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      await expect(
        collectEvents(
          backend.send(session, {
            turnId: 'turn_1',
            threadId: 'thread_1',
            workspaceId: 'workspace_1',
            input: { message: 'hello' },
            model: 'copilot-agent',
          }),
        ),
      ).rejects.toThrow('raw process failure');

      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          message: 'backend turn failed',
          fields: expect.objectContaining({
            event: 'backend.turn.failed',
            failureClass: 'process_exit',
            errorCode: 'backend_process_failed',
          }),
        }),
      );
      expect(JSON.stringify(logger.entries)).not.toContain('raw process failure');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('classifies backend failures after abort as cancelled', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const logger = new CapturingLogger();
    const backend = new CopilotCliBackend({
      runner: new FakeCopilotPromptRunner([], new Error('cancel raw detail')),
      logger,
    });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        collectEvents(
          backend.send(
            session,
            {
              turnId: 'turn_1',
              threadId: 'thread_1',
              workspaceId: 'workspace_1',
              input: { message: 'hello' },
              model: 'copilot-agent',
            },
            controller.signal,
          ),
        ),
      ).rejects.toThrow('cancel raw detail');

      const failed = logger.entries.find(
        (entry) => entry.fields['event'] === 'backend.turn.failed',
      );
      expect(failed?.fields).toMatchObject({
        failureClass: 'cancelled',
        deltaCount: 0,
      });
      expect(failed?.fields['firstAssistantDeltaMs']).toBeUndefined();
      expect(failed?.fields['maxObservedInterDeltaGapMs']).toBeUndefined();
      expect(JSON.stringify(logger.entries)).not.toContain('cancel raw detail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('formats full-history input for the single-prompt Copilot CLI surface', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner();
    const backend = new CopilotCliBackend({ runner });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: {
            message: 'Follow up',
            systemInstructions: 'Be concise.',
            conversationHistory: [
              { role: 'user', content: 'First request' },
              { role: 'assistant', content: 'First answer' },
            ],
          },
          model: 'copilot-agent',
        }),
      );

      expect(runner.lastPrompt).toContain('Volare bridge context:');
      expect(runner.lastPrompt).toContain(
        'No explicit client workspace_root metadata was provided.',
      );
      expect(runner.lastPrompt).toContain(
        `Backend workspace root is a neutral projectless workspace: ${workspace.rootPath}`,
      );
      expect(runner.lastPrompt).toContain('Context provenance rules:');
      expect(runner.lastPrompt).not.toContain('External source-grounding rules:');
      expect(runner.lastPrompt).toContain(
        'System instructions, conversation history, and client attachments are client-provided context, not filesystem evidence.',
      );
      expect(runner.lastPrompt).toContain(
        'Do not say the user pasted or provided a file unless the current user request explicitly did so.',
      );
      expect(runner.lastPrompt).toContain(
        'Do not say a file exists, was read, or defines project rules unless current tool output proves it.',
      );
      expect(runner.lastPrompt).toContain('System instructions:\nBe concise.');
      expect(runner.lastPrompt).toContain(
        'Conversation so far:\nuser: First request\n\nassistant: First answer',
      );
      expect(runner.lastPrompt).toContain('User request:\nFollow up');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('adds external grounding rules after provenance rules and before client instructions', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner();
    const backend = new CopilotCliBackend({ runner });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: {
            message: 'Search recent public filings and cite sources',
            systemInstructions: 'Prefer tables.',
          },
          model: 'copilot-agent',
        }),
      );

      const prompt = runner.lastPrompt ?? '';
      const provenanceIndex = prompt.indexOf('Context provenance rules:');
      const groundingIndex = prompt.indexOf('External source-grounding rules:');
      const systemIndex = prompt.indexOf('System instructions:\nPrefer tables.');
      const userIndex = prompt.indexOf(
        'User request:\nSearch recent public filings and cite sources',
      );
      expect(provenanceIndex).toBeGreaterThan(-1);
      expect(groundingIndex).toBeGreaterThan(provenanceIndex);
      expect(systemIndex).toBeGreaterThan(groundingIndex);
      expect(userIndex).toBeGreaterThan(systemIndex);
      expect(prompt).toContain(
        'If no source evidence is available, say that source evidence is unavailable instead of inventing citations.',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('includes client attachment summaries in the Copilot prompt', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner();
    const backend = new CopilotCliBackend({ runner });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: {
            message: 'Use the provided context',
            attachments: [
              {
                kind: 'image',
                mediaType: 'image/png',
                uri: 'data:image/png;base64,AAAA',
              },
              {
                kind: 'file',
                name: 'notes.txt',
                uri: 'file_123',
              },
            ],
          },
          model: 'copilot-agent',
        }),
      );

      expect(runner.lastPrompt).toContain('Client attachments:');
      expect(runner.lastPrompt).toContain(
        '- kind=image media_type=image/png uri=data:image/png;base64,AAAA',
      );
      expect(runner.lastPrompt).toContain('- kind=file name=notes.txt uri=file_123');
      expect(runner.lastPrompt).toContain('User request:\nUse the provided context');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('marks explicitly requested workspace metadata in the bridge context', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner();
    const backend = new CopilotCliBackend({ runner });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });

      await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: { message: 'Inspect the workspace' },
          metadata: { workspace_root: '/tmp/client-workspace' },
          model: 'copilot-agent',
        }),
      );

      expect(runner.lastPrompt).toContain(
        'Client explicitly requested workspace root: /tmp/client-workspace',
      );
      expect(runner.lastPrompt).toContain(`Backend workspace root: ${workspace.rootPath}`);
      expect(runner.lastPrompt).toContain(
        'Validate workspace facts against current tool output before stating them as facts.',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('delegates cancellation and disposal to the process runner', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner();
    const backend = new CopilotCliBackend({ runner });
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    try {
      const session = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      });
      const backendSessionId = session.backendSessionId;
      expect(backendSessionId).toBeDefined();
      if (!backendSessionId) {
        throw new Error('expected backend session id');
      }

      await expect(
        backend.cancel(session, { timeoutMs: 1, forceAfterTimeout: true }),
      ).resolves.toEqual({ status: 'timed_out' });
      await backend.disposeSession(session);

      expect(runner.cancelled).toEqual([{ backendSessionId, forceAfterTimeout: true }]);
      expect(runner.disposed).toEqual([backendSessionId]);
      await expect(
        collectEvents(
          backend.send(session, {
            turnId: 'turn_1',
            threadId: 'thread_1',
            workspaceId: 'workspace_1',
            input: { message: 'hello' },
            model: 'copilot-agent',
          }),
        ),
      ).rejects.toThrow('Backend session workspace was not found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails session creation when the workspace disappears before spawn', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const workspace: IWorkspace = {
      id: 'workspace_1',
      rootPath: await realpath(root),
    };
    await rm(root, { recursive: true, force: true });
    const backend = new CopilotCliBackend({ runner: new FakeCopilotPromptRunner() });

    await expect(
      backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_1',
        threadId: 'thread_1',
      }),
    ).rejects.toThrow('Workspace root could not be resolved');
  });

  test('extracts text from JSONL and plain text Copilot output', () => {
    expect(
      extractTextFromCopilotOutput(
        '{"type":"session.mcp_servers_loaded","data":{"servers":[]}}\n{"type":"assistant.message_delta","data":{"deltaContent":"hello"}}\n{"type":"assistant.message","data":{"content":"hello"}}\n{"delta":"!"}\n',
      ),
    ).toBe('hello!');
    expect(extractTextFromCopilotOutput('plain text')).toBe('plain text');
    expect(extractTextFromCopilotOutput('"quoted text"')).toBe('quoted text');
    expect(extractTextFromCopilotOutput('"plain text starting with a quote')).toBe(
      '"plain text starting with a quote',
    );
    expect(extractTextFromCopilotOutput('true')).toBe('true');
    expect(() => extractTextFromCopilotOutput('{"delta":')).toThrow(
      'Copilot CLI emitted malformed JSON output',
    );
  });

  test('runs a PATH-resolved Copilot process and streams JSON output', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const bin = await installFakeCopilot(
      'stream',
      `#!/bin/sh
printf '%s\\n' "$@" > "$PWD/args.txt"
printf '{"type":"session.mcp_servers_loaded","data":{"servers":[]}}\\n'
printf '{"type":"assistant.message_delta","data":{"deltaContent":"hello"}}\\n'
`,
    );
    try {
      const runner = new BunCopilotPromptRunner(undefined, bin);
      const chunks: string[] = [];
      for await (const chunk of runner.run('hello', {
        backendSessionId: 'backend_session_1',
        cwd: workspace,
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['hello']);
      const args = await readArgvFile(path.join(workspace, 'args.txt'));
      expect(args).toContain('--allow-all');
      expect(args).not.toContain('--allow-all-urls');
      expect(DEFAULT_COPILOT_CLI_PERMISSION_MODE).toBe('full');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  test('maps configured Copilot permission modes to CLI flags', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const bin = await installFakeCopilot(
      'permission-mode',
      `#!/bin/sh
printf '%s\\n' "$@" > "$PWD/args.txt"
printf '{"type":"assistant.message_delta","data":{"deltaContent":"ok"}}\\n'
`,
    );
    try {
      const restricted = new BunCopilotPromptRunner(undefined, bin, 'restricted');
      const restrictedChunks: string[] = [];
      for await (const chunk of restricted.run('hello', {
        backendSessionId: 'backend_session_1',
        cwd: workspace,
      })) {
        restrictedChunks.push(chunk);
      }
      expect(restrictedChunks).toEqual(['ok']);
      const restrictedArgs = await readArgvFile(path.join(workspace, 'args.txt'));
      expect(restrictedArgs).not.toContain('--allow-all-urls');
      expect(restrictedArgs).not.toContain('--allow-all');

      const web = new BunCopilotPromptRunner(undefined, bin, 'web');
      const webChunks: string[] = [];
      for await (const chunk of web.run('hello', {
        backendSessionId: 'backend_session_2',
        cwd: workspace,
      })) {
        webChunks.push(chunk);
      }
      expect(webChunks).toEqual(['ok']);
      const webArgs = (await readFile(path.join(workspace, 'args.txt'), 'utf8')).split(/\r?\n/);
      expect(webArgs).toContain('--allow-all-urls');
      expect(webArgs).not.toContain('--allow-all');

      const full = new BunCopilotPromptRunner(undefined, bin, 'full');
      const fullChunks: string[] = [];
      for await (const chunk of full.run('hello', {
        backendSessionId: 'backend_session_3',
        cwd: workspace,
      })) {
        fullChunks.push(chunk);
      }
      expect(fullChunks).toEqual(['ok']);
      const fullArgs = await readArgvFile(path.join(workspace, 'args.txt'));
      expect(fullArgs).toContain('--allow-all');
      expect(fullArgs).not.toContain('--allow-all-urls');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  test('terminates the Copilot process when output parsing fails', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const bin = await installFakeCopilot(
      'malformed-output',
      `#!/bin/sh
printf '{"delta":\\n'
trap 'printf terminated > "$PWD/terminated.txt"; exit 0' TERM
while true; do sleep 1; done
`,
    );
    try {
      const runner = new BunCopilotPromptRunner(undefined, bin);
      await expect(
        (async () => {
          for await (const _chunk of runner.run('hello', {
            backendSessionId: 'backend_session_1',
            cwd: workspace,
          })) {
            // Consume until the malformed JSON line fails.
          }
        })(),
      ).rejects.toThrow('Copilot CLI emitted malformed JSON output');
      await expect(runner.cancel('backend_session_1')).resolves.toEqual({ status: 'not_found' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  test('cancels a tracked Copilot process with SIGTERM', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const bin = await installFakeCopilot(
      'cancel',
      `#!/bin/sh
printf '{"type":"assistant.message_delta","data":{"deltaContent":"started"}}\\n'
trap 'exit 0' TERM
while true; do sleep 1; done
`,
    );
    try {
      const runner = new BunCopilotPromptRunner(undefined, bin);
      const iterator = runner
        .run('hello', {
          backendSessionId: 'backend_session_1',
          cwd: workspace,
        })
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: 'started',
      });
      await expect(
        runner.cancel('backend_session_1', { timeoutMs: 100, forceAfterTimeout: false }),
      ).resolves.toEqual({ status: 'cancelled' });
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  test('terminates a tracked Copilot process when the run signal aborts', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const bin = await installFakeCopilot(
      'abort',
      `#!/bin/sh
printf '{"type":"assistant.message_delta","data":{"deltaContent":"started"}}\\n'
trap 'exit 0' TERM
while true; do sleep 1; done
`,
    );
    try {
      const runner = new BunCopilotPromptRunner(undefined, bin);
      const controller = new AbortController();
      const iterator = runner
        .run('hello', {
          backendSessionId: 'backend_session_1',
          cwd: workspace,
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: 'started',
      });
      controller.abort();

      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      await expect(runner.cancel('backend_session_1')).resolves.toEqual({ status: 'not_found' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  test('passes configured permission mode to the default Copilot runner', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const bin = await installFakeCopilot(
      'backend-permission-mode',
      `#!/bin/sh
printf '%s\\n' "$@" > "$PWD/args.txt"
printf '{"type":"assistant.message_delta","data":{"deltaContent":"ok"}}\\n'
`,
    );
    try {
      const backend = new CopilotCliBackend({ command: bin, permissionMode: 'web' });
      const workspaceRoot = await realpath(workspace);
      const session = await backend.createSession(
        { id: 'workspace_1', rootPath: workspaceRoot },
        { bridgeSessionId: 'bridge_session_1', threadId: 'thread_1' },
      );

      const events = await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: { message: 'hello' },
          model: 'copilot-agent',
        }),
      );

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'turn.succeeded', output: { text: 'ok' } }),
      );
      const args = await readArgvFile(path.join(workspace, 'args.txt'));
      expect(args).toContain('--allow-all-urls');
      expect(args).not.toContain('--allow-all');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });
});

async function installFakeCopilot(name: string, source: string): Promise<string> {
  const root = await mkdtemp(path.join(import.meta.dir, `fake-copilot-${name}-`));
  const bin = path.join(root, 'copilot');
  await writeFile(bin, source);
  await chmod(bin, 0o755);
  return bin;
}

async function readArgvFile(filePath: string): Promise<string[]> {
  return (await readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean);
}
