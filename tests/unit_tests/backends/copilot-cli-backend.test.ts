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
  async *run(prompt: string, _options: CopilotPromptRunOptionsInterface): AsyncIterable<string> {
    yield `copilot:${prompt}`;
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
    const backend = new CopilotCliBackend({ runner: new FakeCopilotPromptRunner() });
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
