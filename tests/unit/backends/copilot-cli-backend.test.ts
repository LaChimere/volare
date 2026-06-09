import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  CopilotCliBackend,
  extractTextFromCopilotOutput,
} from '../../../src/backends/copilot-cli/backend';
import { VolareError } from '../../../src/core/errors';
import type { IWorkspace } from '../../../src/core/types';
import {
  CapturingLogger,
  collectEvents,
  FakeCopilotPromptRunner,
} from '../../support/backends/copilot-cli-backend-harness';

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

  test('logs backend completion summary metrics without exact prompt content', async () => {
    const root = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const runner = new FakeCopilotPromptRunner(['hello', ' world']);
    const logger = new CapturingLogger();
    const backend = new CopilotCliBackend({ runner, logger, mcpMode: 'unmediated' });
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
        groundingWarningCodes: ['UNMEDIATED_TOOLING_ENABLED'],
        unmediatedToolingEnabled: true,
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
});
