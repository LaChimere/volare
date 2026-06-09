import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  BunCopilotPromptRunner,
  CopilotCliBackend,
  DEFAULT_COPILOT_CLI_PERMISSION_MODE,
} from '../../../src/backends/copilot-cli/backend';
import { VolareError } from '../../../src/core/errors';
import type { IWorkspace } from '../../../src/core/types';
import {
  CapturingLogger,
  collectEvents,
  FakeCopilotPromptRunner,
  installFakeCopilot,
  readArgvFile,
} from '../../support/backends/copilot-cli-backend-harness';

describe('CopilotCliBackend', () => {
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

  test('ignores structured unmediated MCP frames instead of journaling raw payload text', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const fixture = await readFile(
      path.join(import.meta.dir, '../../fixtures/copilot-cli/unmediated-mcp.jsonl'),
      'utf8',
    );
    const bin = await installFakeCopilot(
      'structured-frames',
      `#!/bin/sh
cat <<'JSON'
${fixture}
JSON
`,
    );
    try {
      const backend = new CopilotCliBackend({
        command: bin,
        permissionMode: 'web',
        mcpMode: 'unmediated',
      });
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
        expect.objectContaining({ type: 'turn.succeeded', output: { text: 'done' } }),
      );
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain('tool.call');
      expect(serialized).not.toContain('fixture.lookup');
      expect(serialized).not.toContain('safe fixture result');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
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
      expect(args).toContain('--disable-builtin-mcps');
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
      expect(restrictedArgs).toContain('--disable-builtin-mcps');
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
      expect(webArgs).toContain('--disable-builtin-mcps');
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
      expect(fullArgs).toContain('--disable-builtin-mcps');
      expect(fullArgs).toContain('--allow-all');
      expect(fullArgs).not.toContain('--allow-all-urls');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  test('omits builtin MCP disabling only in unmediated mode', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const bin = await installFakeCopilot(
      'mcp-mode',
      `#!/bin/sh
printf '%s\\n' "$@" > "$PWD/args.txt"
printf '{"type":"assistant.message_delta","data":{"deltaContent":"ok"}}\\n'
`,
    );
    try {
      const disabled = new BunCopilotPromptRunner(undefined, bin, 'web', 'disabled');
      for await (const _chunk of disabled.run('hello', {
        backendSessionId: 'backend_session_disabled',
        cwd: workspace,
      })) {
        // consume
      }
      expect(await readArgvFile(path.join(workspace, 'args.txt'))).toContain(
        '--disable-builtin-mcps',
      );

      const unmediated = new BunCopilotPromptRunner(undefined, bin, 'web', 'unmediated');
      for await (const _chunk of unmediated.run('hello', {
        backendSessionId: 'backend_session_unmediated',
        cwd: workspace,
      })) {
        // consume
      }
      const args = await readArgvFile(path.join(workspace, 'args.txt'));
      expect(args).not.toContain('--disable-builtin-mcps');
      expect(args).toContain('--allow-all-urls');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });

  test('passes configured certificate environment to Copilot subprocesses', async () => {
    const workspace = await mkdtemp(path.join(import.meta.dir, 'copilot-workspace-'));
    const bin = await installFakeCopilot(
      'child-env',
      `#!/bin/sh
printf '%s\\n' "$SSL_CERT_FILE" "$REQUESTS_CA_BUNDLE" "$CURL_CA_BUNDLE" > "$PWD/env.txt"
printf '{"type":"assistant.message_delta","data":{"deltaContent":"ok"}}\\n'
`,
    );
    try {
      const runner = new BunCopilotPromptRunner(undefined, bin, 'web', 'disabled', {
        SSL_CERT_FILE: '/tmp/cacert.pem',
        REQUESTS_CA_BUNDLE: '/tmp/cacert.pem',
        CURL_CA_BUNDLE: '/tmp/cacert.pem',
      });
      for await (const _chunk of runner.run('hello', {
        backendSessionId: 'backend_session_env',
        cwd: workspace,
      })) {
        // consume
      }
      await expect(readFile(path.join(workspace, 'env.txt'), 'utf8')).resolves.toBe(
        '/tmp/cacert.pem\n/tmp/cacert.pem\n/tmp/cacert.pem\n',
      );
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
      const backend = new CopilotCliBackend({
        command: bin,
        permissionMode: 'web',
        mcpMode: 'unmediated',
      });
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
      expect(args).not.toContain('--disable-builtin-mcps');
      expect(args).toContain('--allow-all-urls');
      expect(args).not.toContain('--allow-all');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(path.dirname(bin), { recursive: true, force: true });
    }
  });
});
