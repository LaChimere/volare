import { describe, expect, test } from 'bun:test';

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
    const backend = new CopilotCliBackend({ runner: new FakeCopilotPromptRunner() });
    const workspace: WorkspaceInterface = {
      id: 'workspace_1',
      rootPath: '/tmp/agent-loom-test',
    };
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
