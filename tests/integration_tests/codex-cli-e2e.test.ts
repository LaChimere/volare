import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DurableSessionManager } from '../../src/core/durable-session-manager';
import type {
  AgentEvent,
  IAgentBackend,
  IAgentRequest,
  IBackendCapabilities,
  IBackendSession,
  ICancelOptions,
  ICancelResult,
  ICreateSessionOptions,
  IWorkspace,
} from '../../src/core/types';
import { createEstimatedUsage } from '../../src/core/usage';
import { createApp } from '../../src/server/app';
import { createServerRuntimeConfig } from '../../src/server/config';
import { migrate } from '../../src/state/migrations';
import { SQLiteStateStore } from '../../src/state/sqlite-store';

const apiKey = '0123456789abcdef';
const codexExecTimeoutMs = 45_000;
// Terms from Volare/Codex config projects that must not leak into isolated test projects.
const unrelatedProjectContextTerms = [
  'AGENTS.md',
  'auth.json',
  'config.toml',
  'version.json',
  'skills/',
];

describe('Codex CLI end-to-end integration', () => {
  test('routes a temporary project through Volare without leaking unrelated project context', async () => {
    await assertCodexCliAvailable();
    const fixture = await createCodexE2EFixture();
    const backend = new ProjectStatusBackend();
    const server = startE2EServer(fixture.projectRoot, backend);

    try {
      await configureCodexForE2E(fixture.codexHome, server.baseUrl);

      const result = await runCodexExec({
        cwd: fixture.projectRoot,
        codexHome: fixture.codexHome,
        outputPath: fixture.outputPath,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(backend.requests).toHaveLength(1);
      expect(backend.workspaceRoots).toEqual([fixture.projectRoot]);
      expectNoUnrelatedProjectContext(JSON.stringify(backend.requests[0]));
      expectProjectOnlyStatus(await readFile(fixture.outputPath, 'utf8'));
    } finally {
      await server.stop();
      await fixture.dispose();
    }
  }, 60_000);

  test('supports the standard OpenAI v1 base path through Codex CLI', async () => {
    await assertCodexCliAvailable();
    const fixture = await createCodexE2EFixture();
    const backend = new ProjectStatusBackend();
    const server = startE2EServer(fixture.projectRoot, backend);

    try {
      await configureCodexForE2E(fixture.codexHome, server.baseUrl, {
        basePath: '/v1',
      });

      const result = await runCodexExec({
        cwd: fixture.projectRoot,
        codexHome: fixture.codexHome,
        outputPath: fixture.outputPath,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(backend.requests).toHaveLength(1);
      expect(backend.workspaceRoots).toEqual([fixture.projectRoot]);
      expectProjectOnlyStatus(await readFile(fixture.outputPath, 'utf8'));
    } finally {
      await server.stop();
      await fixture.dispose();
    }
  }, 60_000);

  test('rejects Codex CLI workspaces outside the Volare allowlist', async () => {
    await assertCodexCliAvailable();
    const fixture = await createCodexE2EFixture();
    const allowedFixture = await createCodexE2EFixture('allowed-project');
    const backend = new ProjectStatusBackend();
    const server = startE2EServer(allowedFixture.projectRoot, backend);

    try {
      await configureCodexForE2E(fixture.codexHome, server.baseUrl);

      const result = await runCodexExec({
        cwd: fixture.projectRoot,
        codexHome: fixture.codexHome,
        outputPath: fixture.outputPath,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('unexpected status 403 Forbidden');
      expect(result.stderr).toContain('Workspace root is outside the allowed roots');
      expect(backend.requests).toEqual([]);
      expect(backend.workspaceRoots).toEqual([]);
    } finally {
      await server.stop();
      await fixture.dispose();
      await allowedFixture.dispose();
    }
  }, 60_000);
});

interface ICodexE2EFixture {
  root: string;
  projectRoot: string;
  codexHome: string;
  outputPath: string;
  dispose(): Promise<void>;
}

interface ICodexE2EServer {
  baseUrl: string;
  stop(): Promise<void>;
}

async function assertCodexCliAvailable(): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['codex', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (cause) {
    throw new Error('codex CLI is required for integration tests but was not found on PATH', {
      cause,
    });
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readPipeText(proc.stdout),
    readPipeText(proc.stderr),
  ]);
  expect(exitCode, `codex --version failed\nstdout=${stdout}\nstderr=${stderr}`).toBe(0);
}

class ProjectStatusBackend implements IAgentBackend {
  readonly name = 'project-status';
  readonly requests: IAgentRequest[] = [];
  readonly workspaceRoots: string[] = [];
  readonly #workspaceRootsBySession = new Map<string, string>();

  capabilities(): IBackendCapabilities {
    return {
      persistentSessions: false,
      serverSideTools: false,
      permissionRequests: false,
      externalApprovalDecisions: false,
      backendInternalPauseResume: false,
      cancellation: true,
    };
  }

  async createSession(
    workspace: IWorkspace,
    options: ICreateSessionOptions,
  ): Promise<IBackendSession> {
    const backendSessionId = `project_status_${options.bridgeSessionId}`;
    this.workspaceRoots.push(workspace.rootPath);
    this.#workspaceRootsBySession.set(backendSessionId, workspace.rootPath);
    return {
      bridgeSessionId: options.bridgeSessionId,
      backendSessionId,
      workspaceId: workspace.id,
      threadId: options.threadId,
      status: 'active',
    };
  }

  async resumeSession(session: IBackendSession): Promise<IBackendSession> {
    return session;
  }

  async *send(
    session: IBackendSession,
    request: IAgentRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    if (signal?.aborted) {
      yield { type: 'turn.cancelled', turnId: request.turnId };
      return;
    }

    const root = this.#workspaceRootsBySession.get(session.backendSessionId ?? '');
    if (!root) {
      yield {
        type: 'turn.failed',
        turnId: request.turnId,
        error: { code: 'backend_session_not_found' },
      };
      return;
    }

    const entries = (await readdir(root)).sort();
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    const output = [
      'Project status: temporary placeholder workspace.',
      `Visible files: ${entries.join(', ') || 'none'}.`,
      readme.includes('No application source code has been added yet.')
        ? 'README says no application source code has been added yet.'
        : 'README status marker was not found.',
    ].join('\n');

    yield { type: 'text.delta', turnId: request.turnId, delta: output };
    yield {
      type: 'turn.succeeded',
      turnId: request.turnId,
      output: { text: output },
      usage: createEstimatedUsage(request.input.message, output),
    };
  }

  async cancel(_session: IBackendSession, _options?: ICancelOptions): Promise<ICancelResult> {
    return { status: 'cancelled' };
  }

  async disposeSession(_session: IBackendSession): Promise<void> {}
}

async function createCodexE2EFixture(projectDirName = 'project'): Promise<ICodexE2EFixture> {
  const root = await mkdtemp(join(tmpdir(), 'volare-codex-cli-e2e-'));
  const projectPath = join(root, projectDirName);
  const codexHome = join(root, 'codex-home');
  const outputPath = join(root, 'last-message.txt');
  await mkdir(projectPath, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const projectRoot = await realpath(projectPath);
  await writeFile(
    join(projectRoot, 'README.md'),
    [
      '# temporary-project',
      '',
      'This is a temporary workspace for Volare Codex CLI integration testing.',
      '',
      '## Status',
      '',
      '- No application source code has been added yet.',
      '- No build system or test framework is configured.',
    ].join('\n'),
  );
  return {
    root,
    projectRoot,
    codexHome,
    outputPath,
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function startE2EServer(projectRoot: string, backend: IAgentBackend): ICodexE2EServer {
  const database = new Database(':memory:');
  migrate(database);
  const stateStore = new SQLiteStateStore(database);
  const config = createServerRuntimeConfig({
    VOLARE_API_KEY: apiKey,
    VOLARE_ALLOWED_WORKSPACE_ROOTS: projectRoot,
    VOLARE_PROJECTLESS_WORKSPACE_ROOT: join(dirname(projectRoot), 'projectless-workspace'),
  });
  const app = createApp({
    config,
    stateStore,
    sessionManager: new DurableSessionManager({ store: stateStore, backend }),
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: app.fetch,
  });
  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    async stop(): Promise<void> {
      try {
        await server.stop(true);
      } finally {
        database.close();
      }
    },
  };
}

async function configureCodexForE2E(
  codexHome: string,
  baseUrl: string,
  options: { basePath?: '/openai/v1' | '/v1' } = {},
): Promise<void> {
  const configPath = join(codexHome, 'config.toml');
  const profilePath = join(codexHome, 'volare.config.toml');
  await writeFile(configPath, 'approval_policy = "never"\n');
  await writeFile(
    profilePath,
    [
      'model_provider = "volare"',
      'model = "gpt-5.5"',
      'model_reasoning_effort = "high"',
      '',
      '[model_providers.volare]',
      'name = "Volare"',
      `base_url = "${baseUrl}${options.basePath ?? '/openai/v1'}"`,
      'wire_api = "responses"',
      'env_key = "VOLARE_API_KEY"',
      'requires_openai_auth = false',
      'supports_websockets = false',
      '',
    ].join('\n'),
  );
}

async function runCodexExec(options: {
  cwd: string;
  codexHome: string;
  outputPath: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      'codex',
      'exec',
      '--profile',
      'volare',
      '--cd',
      options.cwd,
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--output-last-message',
      options.outputPath,
      'What is the status of this project? Answer only from the current project files.',
    ],
    {
      cwd: options.cwd,
      env: {
        ...Bun.env,
        CODEX_HOME: options.codexHome,
        VOLARE_API_KEY: apiKey,
        NO_COLOR: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, codexExecTimeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      readPipeText(proc.stdout),
      readPipeText(proc.stderr),
    ]);
    if (timedOut) {
      throw new Error(
        [
          `codex exec exceeded ${codexExecTimeoutMs}ms and was terminated`,
          `stdout=${stdout.slice(0, 2_000)}`,
          `stderr=${stderr.slice(0, 2_000)}`,
        ].join('\n'),
      );
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function readPipeText(
  pipe: ReadableStream<Uint8Array> | number | undefined,
): Promise<string> {
  return pipe instanceof ReadableStream ? await new Response(pipe).text() : '';
}

function expectProjectOnlyStatus(output: string): void {
  const leaked = unrelatedProjectContextTerms.filter((value) => output.includes(value));
  expect(leaked).toEqual([]);
  expect(output).toContain('README.md');
  expect(output).toContain('no application source code has been added yet');
}

function expectNoUnrelatedProjectContext(output: string): void {
  const leaked = unrelatedProjectContextTerms.filter((value) => output.includes(value));
  expect(leaked).toEqual([]);
}
