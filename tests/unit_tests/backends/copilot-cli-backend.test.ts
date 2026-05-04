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
import type { AgentEvent, IWorkspace } from '../../../src/core/types';

class FakeCopilotPromptRunner implements ICopilotPromptRunner {
  lastOptions?: ICopilotPromptRunOptions;
  lastPrompt?: string;
  readonly cancelled: Array<{ backendSessionId: string; forceAfterTimeout?: boolean }> = [];
  readonly disposed: string[] = [];

  async *run(prompt: string, options: ICopilotPromptRunOptions): AsyncIterable<string> {
    this.lastPrompt = prompt;
    this.lastOptions = options;
    yield `copilot:${prompt}`;
  }

  async cancel(backendSessionId: string, options = { timeoutMs: 0, forceAfterTimeout: false }) {
    this.cancelled.push({ backendSessionId, forceAfterTimeout: options.forceAfterTimeout });
    return { status: options.forceAfterTimeout ? 'timed_out' : 'cancelled' } as const;
  }

  async dispose(backendSessionId: string) {
    this.disposed.push(backendSessionId);
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

      expect(runner.lastPrompt).toContain('Agent Loom bridge context:');
      expect(runner.lastPrompt).toContain(
        'No explicit client workspace_root metadata was provided.',
      );
      expect(runner.lastPrompt).toContain(
        `Backend workspace root is a neutral projectless workspace: ${workspace.rootPath}`,
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
