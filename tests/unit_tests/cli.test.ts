import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  defaultDaemonPaths,
  type ICliDependencies,
  type ICliIo,
  type ICliWriter,
  parseCli,
  runCli,
} from '../../src/cli';

class MemoryWriter implements ICliWriter {
  readonly chunks: string[] = [];

  write(chunk: Uint8Array): void {
    this.chunks.push(new TextDecoder().decode(chunk));
  }

  text(): string {
    return this.chunks.join('');
  }
}

function memoryIo(): { io: ICliIo; stdout: MemoryWriter; stderr: MemoryWriter } {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  return { io: { stdout, stderr }, stdout, stderr };
}

function testDependencies(overrides: Partial<ICliDependencies> = {}): ICliDependencies {
  return {
    configureCodex: async () => ({ configPath: '/tmp/config.toml', changed: false }),
    startRuntime: async () => {
      throw new Error('unexpected runtime start');
    },
    installSignalHandlers: () => {
      throw new Error('unexpected signal handler install');
    },
    startDaemon: async () => ({
      pid: 1234,
      logPath: '/tmp/volare.log',
      pidPath: '/tmp/volare.pid',
    }),
    stopDaemon: async () => ({ stopped: false, pidPath: '/tmp/volare.pid' }),
    getDaemonStatus: async () => ({
      running: false,
      pidPath: '/tmp/volare.pid',
      logPath: '/tmp/volare.log',
    }),
    getDaemonPaths: () => ({
      rootDir: '/tmp/volare',
      logPath: '/tmp/volare.log',
      pidPath: '/tmp/volare.pid',
      stateDatabasePath: '/tmp/state.sqlite',
    }),
    getEnv: () => ({ VOLARE_API_KEY: 'replace-with-at-least-16-characters' }),
    readPersistentEnv: async () => ({}),
    setupVolare: async () => ({
      apiKeySource: 'generated',
      envPath: '/tmp/volare/env',
      codexConfig: { configPath: '/tmp/config.toml', changed: true },
    }),
    updatePackage: async () => ({ latestVersion: '0.3.3' }),
    ...overrides,
  };
}

describe('Volare CLI', () => {
  test('reports the package version', async () => {
    const { io, stdout } = memoryIo();
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };

    const exitCode = await runCli(['version'], testDependencies(), io);

    expect(exitCode).toBe(0);
    expect(stdout.text().trim()).toBe(packageJson.version);
  });

  test('runs bunx update flow', async () => {
    const { io, stdout } = memoryIo();
    let calls = 0;

    const exitCode = await runCli(
      ['update'],
      testDependencies({
        updatePackage: async () => {
          calls += 1;
          return { latestVersion: '0.3.3' };
        },
      }),
      io,
    );

    expect(exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(stdout.text()).toContain(
      "Refreshing Bun's global package cache and resolving @lachimere/volare@latest",
    );
    expect(stdout.text()).toContain('Volare update complete. Latest version: 0.3.3');
    expect(stdout.text()).toContain('@lachimere/volare@latest');
  });

  test('runs setup flow and does not print the generated token', async () => {
    const { io, stdout } = memoryIo();
    const calls: unknown[] = [];

    const exitCode = await runCli(
      ['setup', '--config', '/tmp/codex.toml', '--base-url', 'http://127.0.0.1:8765/openai/v1'],
      testDependencies({
        setupVolare: async (options) => {
          calls.push(options);
          return {
            apiKeySource: 'generated',
            envPath: '/tmp/volare/env',
            codexConfig: {
              configPath: '/tmp/codex.toml',
              changed: true,
              backupPath: '/tmp/codex.toml.volare-backup-test',
            },
            macosEnvironment: {
              launchAgentPath: '/tmp/LaunchAgents/com.lachimere.volare.env.plist',
            },
          };
        },
      }),
      io,
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        forceToken: false,
        configureCodex: true,
        macosEnvironment: true,
        codexConfigPath: '/tmp/codex.toml',
        baseUrl: 'http://127.0.0.1:8765/openai/v1',
      },
    ]);
    expect(stdout.text()).toContain('Volare setup complete.');
    expect(stdout.text()).toContain('API token: generated and saved to /tmp/volare/env');
    expect(stdout.text()).toContain('Configured Codex: /tmp/codex.toml');
    expect(stdout.text()).toContain('Restart Codex Desktop after setup');
    expect(stdout.text()).not.toContain('replace-with-at-least-16-characters');
  });

  test('parses setup options', () => {
    expect(parseCli(['setup', '--force-token', '--no-codex', '--no-macos-env'])).toEqual({
      type: 'setup',
      options: {
        forceToken: true,
        configureCodex: false,
        macosEnvironment: false,
      },
    });
  });

  test('parses start options into runtime environment overrides', () => {
    expect(
      parseCli([
        'start',
        '-d',
        '--host',
        '127.0.0.1',
        '--port=8765',
        '--state-db',
        '/tmp/state.sqlite',
        '--workspace-root',
        '/tmp/workspace',
        '--projectless-workspace-root=/tmp/projectless',
        '--log-level',
        'debug',
        '--copilot-permission-mode=full',
      ]),
    ).toEqual({
      type: 'start',
      daemon: true,
      env: {
        VOLARE_HOST: '127.0.0.1',
        VOLARE_PORT: '8765',
        VOLARE_STATE_DB_PATH: '/tmp/state.sqlite',
        VOLARE_WORKSPACE_ROOT: '/tmp/workspace',
        VOLARE_PROJECTLESS_WORKSPACE_ROOT: '/tmp/projectless',
        VOLARE_LOG_LEVEL: 'debug',
        VOLARE_COPILOT_PERMISSION_MODE: 'full',
      },
      daemonArgs: [
        'start',
        '--host',
        '127.0.0.1',
        '--port',
        '8765',
        '--state-db',
        '/tmp/state.sqlite',
        '--workspace-root',
        '/tmp/workspace',
        '--projectless-workspace-root',
        '/tmp/projectless',
        '--log-level',
        'debug',
        '--copilot-permission-mode',
        'full',
      ],
    });
  });

  test('runs config codex with explicit options', async () => {
    const { io, stdout } = memoryIo();
    const calls: unknown[] = [];
    const exitCode = await runCli(
      [
        'config',
        'codex',
        '--config',
        '/tmp/codex.toml',
        '--base-url',
        'http://127.0.0.1:8765/openai/v1',
        '--env-key',
        'CUSTOM_VOLARE_API_KEY',
      ],
      testDependencies({
        configureCodex: async (options) => {
          calls.push(options);
          return { configPath: '/tmp/codex.toml', changed: true, backupPath: '/tmp/backup' };
        },
      }),
      io,
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        configPath: '/tmp/codex.toml',
        baseUrl: 'http://127.0.0.1:8765/openai/v1',
        envKey: 'CUSTOM_VOLARE_API_KEY',
      },
    ]);
    expect(stdout.text()).toContain('Configured Codex for Volare: /tmp/codex.toml');
    expect(stdout.text()).toContain('Backup written: /tmp/backup');
  });

  test('runs daemon start without starting the foreground runtime', async () => {
    const { io, stdout } = memoryIo();
    const calls: unknown[] = [];
    const exitCode = await runCli(
      ['start', '--daemon', '--port', '8765', '--copilot-permission-mode', 'web'],
      testDependencies({
        startDaemon: async (command) => {
          calls.push(command);
          return {
            pid: 4242,
            logPath: '/tmp/volare.log',
            pidPath: '/tmp/volare.pid',
          };
        },
      }),
      io,
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: 'start',
      daemon: true,
      env: { VOLARE_PORT: '8765', VOLARE_COPILOT_PERMISSION_MODE: 'web' },
      daemonArgs: ['start', '--port', '8765', '--copilot-permission-mode', 'web'],
    });
    expect(stdout.text()).toContain('Volare daemon started (pid 4242)');
  });

  test('warns when starting daemon without a stable API key', async () => {
    const { io, stderr } = memoryIo();
    const exitCode = await runCli(
      ['start', '--daemon'],
      testDependencies({
        getEnv: () => ({}),
        readPersistentEnv: async () => ({}),
      }),
      io,
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toContain('Warning: VOLARE_API_KEY is not set');
    expect(stderr.text()).toContain('bunx @lachimere/volare setup');
  });

  test('does not warn when daemon start can use the persisted API key', async () => {
    const { io, stderr } = memoryIo();
    const exitCode = await runCli(
      ['start', '--daemon'],
      testDependencies({
        getEnv: () => ({}),
        readPersistentEnv: async () => ({ VOLARE_API_KEY: 'persisted-token-1234567890' }),
      }),
      io,
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe('');
  });

  test('rejects invalid Copilot permission modes before daemon startup', async () => {
    const { io, stderr } = memoryIo();
    const calls: unknown[] = [];
    const exitCode = await runCli(
      ['start', '--daemon', '--copilot-permission-mode', 'ask'],
      testDependencies({
        startDaemon: async (command) => {
          calls.push(command);
          return {
            pid: 4242,
            logPath: '/tmp/volare.log',
            pidPath: '/tmp/volare.pid',
          };
        },
      }),
      io,
    );

    expect(exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(stderr.text()).toContain('--copilot-permission-mode "ask" is not valid');
    expect(stderr.text()).toContain('Valid modes: restricted, web, or full');
    expect(stderr.text()).toContain('bunx @lachimere/volare start --copilot-permission-mode web');
  });

  test('rejects missing start option values before daemon startup', async () => {
    const { io, stderr } = memoryIo();
    const calls: unknown[] = [];
    const exitCode = await runCli(
      ['start', '--daemon', '--port'],
      testDependencies({
        startDaemon: async (command) => {
          calls.push(command);
          return {
            pid: 4242,
            logPath: '/tmp/volare.log',
            pidPath: '/tmp/volare.pid',
          };
        },
      }),
      io,
    );

    expect(exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(stderr.text()).toContain('Missing value for --port');
  });

  test('rejects unknown config targets and missing config option values', async () => {
    const invalidTarget = memoryIo();
    const missingValue = memoryIo();

    expect(await runCli(['config', 'plugins'], testDependencies(), invalidTarget.io)).toBe(2);
    expect(invalidTarget.stderr.text()).toContain('Expected config target: codex');
    expect(
      await runCli(['config', 'codex', '--base-url'], testDependencies(), missingValue.io),
    ).toBe(2);
    expect(missingValue.stderr.text()).toContain('Missing value for --base-url');
  });

  test('reports daemon status and log paths', async () => {
    const { io, stdout } = memoryIo();
    const exitCode = await runCli(
      ['status'],
      testDependencies({
        getDaemonStatus: async () => ({
          running: true,
          pid: 4242,
          pidPath: '/tmp/volare.pid',
          logPath: '/tmp/volare.log',
        }),
      }),
      io,
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain('Volare daemon is running (pid 4242).');
    expect(stdout.text()).toContain('PID file: /tmp/volare.pid');
    expect(stdout.text()).toContain('Logs: /tmp/volare.log');
  });

  test('derives stable daemon paths from VOLARE_HOME', () => {
    expect(defaultDaemonPaths({ VOLARE_HOME: '/tmp/volare-home' })).toEqual({
      rootDir: '/tmp/volare-home',
      logPath: '/tmp/volare-home/logs/volare.log',
      pidPath: '/tmp/volare-home/volare.pid',
      stateDatabasePath: '/tmp/volare-home/state.sqlite',
    });
  });
});
