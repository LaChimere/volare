import { describe, expect, test } from 'bun:test';

import { MockBackend } from '../../../src/backends/mock/backend';
import type {
  AgentEvent,
  AgentRequestInterface,
  WorkspaceInterface,
} from '../../../src/core/types';

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('MockBackend', () => {
  test('exposes the Phase 0 approval capability metadata shape', () => {
    const backend = new MockBackend();

    expect(backend.capabilities()).toEqual({
      persistentSessions: false,
      serverSideTools: false,
      permissionRequests: true,
      externalApprovalDecisions: false,
      backendInternalPauseResume: true,
      cancellation: true,
    });
  });

  test('echoes a deterministic text response for contract tests', async () => {
    const backend = new MockBackend();
    const workspace: WorkspaceInterface = {
      id: 'workspace_1',
      rootPath: '/tmp/agent-loom-test',
    };
    const session = await backend.createSession(workspace, {
      bridgeSessionId: 'bridge_session_1',
      threadId: 'thread_1',
    });
    const request: AgentRequestInterface = {
      turnId: 'turn_1',
      threadId: 'thread_1',
      workspaceId: 'workspace_1',
      model: 'mock-model',
      input: {
        message: 'hello',
      },
    };

    const events = await collectEvents(backend.send(session, request));

    expect(events).toEqual([
      { type: 'text.delta', turnId: 'turn_1', delta: 'hello' },
      { type: 'turn.succeeded', turnId: 'turn_1', output: { text: 'hello' } },
    ]);
  });

  test('fails closed on workspace or thread mismatch', async () => {
    const backend = new MockBackend();
    const workspace: WorkspaceInterface = {
      id: 'workspace_1',
      rootPath: '/tmp/agent-loom-test',
    };
    const session = await backend.createSession(workspace, {
      bridgeSessionId: 'bridge_session_1',
      threadId: 'thread_1',
    });
    const request: AgentRequestInterface = {
      turnId: 'turn_1',
      threadId: 'thread_2',
      workspaceId: 'workspace_1',
      model: 'mock-model',
      input: {
        message: 'hello',
      },
    };

    const events = await collectEvents(backend.send(session, request));

    expect(events).toEqual([
      {
        type: 'turn.failed',
        turnId: 'turn_1',
        error: { code: 'backend_session_mismatch' },
      },
    ]);
  });
});
