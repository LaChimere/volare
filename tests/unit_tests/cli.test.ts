import { describe, expect, test } from 'bun:test';
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
      logPath: '/tmp/agent-loom.log',
      pidPath: '/tmp/agent-loom.pid',
    }),
    stopDaemon: async () => ({ stopped: false, pidPath: '/tmp/agent-loom.pid' }),
    getDaemonStatus: async () => ({
      running: false,
      pidPath: '/tmp/agent-loom.pid',
      logPath: '/tmp/agent-loom.log',
    }),
    getDaemonPaths: () => ({
      rootDir: '/tmp/agent-loom',
      logPath: '/tmp/agent-loom.log',
      pidPath: '/tmp/agent-loom.pid',
      stateDatabasePath: '/tmp/state.sqlite',
    }),
    ...overrides,
  };
}

describe('Agent Loom CLI', () => {
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
      ]),
    ).toEqual({
      type: 'start',
      daemon: true,
      env: {
        AGENT_LOOM_HOST: '127.0.0.1',
        AGENT_LOOM_PORT: '8765',
        AGENT_LOOM_STATE_DB_PATH: '/tmp/state.sqlite',
        AGENT_LOOM_WORKSPACE_ROOT: '/tmp/workspace',
        AGENT_LOOM_PROJECTLESS_WORKSPACE_ROOT: '/tmp/projectless',
        AGENT_LOOM_LOG_LEVEL: 'debug',
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
        'CUSTOM_AGENT_LOOM_API_KEY',
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
        envKey: 'CUSTOM_AGENT_LOOM_API_KEY',
      },
    ]);
    expect(stdout.text()).toContain('Configured Codex for Agent Loom: /tmp/codex.toml');
    expect(stdout.text()).toContain('Backup written: /tmp/backup');
  });

  test('runs daemon start without starting the foreground runtime', async () => {
    const { io, stdout } = memoryIo();
    const calls: unknown[] = [];
    const exitCode = await runCli(
      ['start', '--daemon', '--port', '8765'],
      testDependencies({
        startDaemon: async (command) => {
          calls.push(command);
          return {
            pid: 4242,
            logPath: '/tmp/agent-loom.log',
            pidPath: '/tmp/agent-loom.pid',
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
      env: { AGENT_LOOM_PORT: '8765' },
      daemonArgs: ['start', '--port', '8765'],
    });
    expect(stdout.text()).toContain('Agent Loom daemon started (pid 4242)');
  });

  test('reports daemon status and log paths', async () => {
    const { io, stdout } = memoryIo();
    const exitCode = await runCli(
      ['status'],
      testDependencies({
        getDaemonStatus: async () => ({
          running: true,
          pid: 4242,
          pidPath: '/tmp/agent-loom.pid',
          logPath: '/tmp/agent-loom.log',
        }),
      }),
      io,
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain('Agent Loom daemon is running (pid 4242).');
    expect(stdout.text()).toContain('PID file: /tmp/agent-loom.pid');
    expect(stdout.text()).toContain('Logs: /tmp/agent-loom.log');
  });

  test('derives stable daemon paths from AGENT_LOOM_HOME', () => {
    expect(defaultDaemonPaths({ AGENT_LOOM_HOME: '/tmp/agent-loom-home' })).toEqual({
      rootDir: '/tmp/agent-loom-home',
      logPath: '/tmp/agent-loom-home/logs/agent-loom.log',
      pidPath: '/tmp/agent-loom-home/agent-loom.pid',
      stateDatabasePath: '/tmp/agent-loom-home/state.sqlite',
    });
  });
});
