import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BunCopilotPromptRunner,
  CopilotCliBackend,
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
});

async function installFakeCopilot(name: string, source: string): Promise<string> {
  const root = await mkdtemp(path.join(import.meta.dir, `fake-copilot-${name}-`));
  const bin = path.join(root, 'copilot');
  await writeFile(bin, source);
  await chmod(bin, 0o755);
  return bin;
}
