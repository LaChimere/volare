import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { CopilotCliBackend } from '../../../src/backends/copilot-cli/backend';
import { VolareError } from '../../../src/core/errors';
import type { AgentEvent, IWorkspace } from '../../../src/core/types';
import {
  CapturingLogger,
  collectEvents,
  FakeCopilotPromptRunner,
} from '../../support/backends/copilot-cli-backend-harness';

describe('CopilotCliBackend', () => {
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

  test('maps runner cancellation to a cancelled turn event', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const logger = new CapturingLogger();
    const backend = new CopilotCliBackend({
      runner: new FakeCopilotPromptRunner(
        ['partial'],
        new VolareError('backend_cancelled', 'cancelled raw detail'),
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

      const events = await collectEvents(
        backend.send(session, {
          turnId: 'turn_1',
          threadId: 'thread_1',
          workspaceId: 'workspace_1',
          input: { message: 'hello' },
          model: 'copilot-agent',
        }),
      );

      expect(events.map((event) => event.type)).toEqual(['text.delta', 'turn.cancelled']);
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          message: 'backend turn cancelled',
          fields: expect.objectContaining({
            event: 'backend.turn.cancelled',
            outputChars: 7,
            deltaCount: 1,
          }),
        }),
      );
      expect(JSON.stringify(logger.entries)).not.toContain('cancelled raw detail');
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
      const secondSession = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_2',
        threadId: 'thread_2',
      });
      const thirdSession = await backend.createSession(workspace, {
        bridgeSessionId: 'bridge_session_3',
        threadId: 'thread_3',
      });
      await backend.dispose();
      expect(runner.disposed).toEqual([
        backendSessionId,
        secondSession.backendSessionId ?? 'missing_second_backend_session',
        thirdSession.backendSessionId ?? 'missing_third_backend_session',
      ]);
      await expect(
        backend.createSession(workspace, {
          bridgeSessionId: 'bridge_session_4',
          threadId: 'thread_4',
        }),
      ).rejects.toMatchObject({
        code: 'service_unavailable',
        cause: { retryAfterMs: 1000, reason: 'shutdown' },
      });
      await expect(backend.resumeSession(secondSession)).rejects.toMatchObject({
        code: 'service_unavailable',
        cause: { retryAfterMs: 1000, reason: 'shutdown' },
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
      ).rejects.toMatchObject({
        code: 'service_unavailable',
        cause: { retryAfterMs: 1000, reason: 'shutdown' },
      });
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
});
