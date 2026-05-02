import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  CopilotCliBackend,
  type CopilotPromptRunnerInterface,
  type CopilotPromptRunOptionsInterface,
  extractTextFromCopilotOutput,
} from '../../../src/backends/copilot-cli/backend';
import type { AgentEvent, WorkspaceInterface } from '../../../src/core/types';

class FakeCopilotPromptRunner implements CopilotPromptRunnerInterface {
  lastOptions?: CopilotPromptRunOptionsInterface;
  readonly cancelled: Array<{ backendSessionId: string; forceAfterTimeout?: boolean }> = [];
  readonly disposed: string[] = [];

  async *run(prompt: string, options: CopilotPromptRunOptionsInterface): AsyncIterable<string> {
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
    const workspace: WorkspaceInterface = {
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

      expect(events).toEqual([
        { type: 'text.delta', turnId: 'turn_1', delta: 'copilot:hello' },
        { type: 'turn.succeeded', turnId: 'turn_1', output: { text: 'copilot:hello' } },
      ]);
      expect(runner.lastOptions).toMatchObject({
        backendSessionId: session.backendSessionId,
        cwd: workspace.rootPath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('delegates cancellation and disposal to the process runner', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner();
    const backend = new CopilotCliBackend({ runner });
    const workspace: WorkspaceInterface = {
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
    const workspace: WorkspaceInterface = {
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
        '{"type":"assistant","assistant_response":"hello"}\n{"delta":"!"}\n',
      ),
    ).toBe('hello!');
    expect(extractTextFromCopilotOutput('plain text')).toBe('plain text');
  });
});
