#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configureCodex, type ICodexConfigOptions } from '../scripts/config-codex';
import { isCopilotCliPermissionMode } from './backends/copilot-cli/backend';
import {
  type IVolareRuntime,
  type IVolareRuntimeOptions,
  installRuntimeSignalHandlers,
  startVolareRuntime,
} from './runtime/server';
import type { IServerRuntimeEnv } from './server/config';

const VERSION = '0.3.1';

export type ICliCommand =
  | { type: 'help' }
  | { type: 'version' }
  | {
      type: 'start';
      daemon: boolean;
      env: Partial<IServerRuntimeEnv>;
      daemonArgs: string[];
    }
  | { type: 'config-codex'; options: ICodexConfigOptions }
  | { type: 'status' }
  | { type: 'stop' }
  | { type: 'logs' };

export interface ICliIo {
  stdout: ICliWriter;
  stderr: ICliWriter;
}

export interface ICliWriter {
  write(chunk: Uint8Array): unknown;
}

export interface ICliDependencies {
  configureCodex: (options?: ICodexConfigOptions) => Promise<{
    configPath: string;
    changed: boolean;
    backupPath?: string;
  }>;
  startRuntime: (options?: IVolareRuntimeOptions) => Promise<IVolareRuntime>;
  installSignalHandlers: (runtime: IVolareRuntime) => void;
  startDaemon: (command: Extract<ICliCommand, { type: 'start' }>) => Promise<IDaemonStartResult>;
  stopDaemon: () => Promise<IDaemonStopResult>;
  getDaemonStatus: () => Promise<IDaemonStatusResult>;
  getDaemonPaths: () => IDaemonPaths;
  getEnv: () => Record<string, string | undefined>;
}

export interface IDaemonPaths {
  rootDir: string;
  logPath: string;
  pidPath: string;
  stateDatabasePath: string;
}

export interface IDaemonStartResult {
  pid: number;
  logPath: string;
  pidPath: string;
}

export interface IDaemonStatusResult {
  running: boolean;
  pid?: number;
  pidPath: string;
  logPath: string;
}

export interface IDaemonStopResult {
  stopped: boolean;
  pid?: number;
  pidPath: string;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export async function runCli(
  argv: string[],
  dependencies: ICliDependencies = defaultDependencies(),
  io: ICliIo = defaultIo(),
): Promise<number> {
  try {
    const command = parseCli(argv);
    switch (command.type) {
      case 'help':
        await writeLine(io.stdout, usage());
        return 0;
      case 'version':
        await writeLine(io.stdout, VERSION);
        return 0;
      case 'start':
        if (command.daemon) {
          if (!dependencies.getEnv()['VOLARE_API_KEY']?.trim()) {
            await writeLine(
              io.stderr,
              'Warning: VOLARE_API_KEY is not set. The daemon will generate an ephemeral token in its logs; export VOLARE_API_KEY before starting for Codex CLI/Desktop.',
            );
          }
          const result = await dependencies.startDaemon(command);
          await writeLine(
            io.stdout,
            `Volare daemon started (pid ${result.pid}). Logs: ${result.logPath}`,
          );
          return 0;
        }
        dependencies.installSignalHandlers(await dependencies.startRuntime({ env: command.env }));
        return 0;
      case 'config-codex': {
        const result = await dependencies.configureCodex(command.options);
        if (result.changed) {
          await writeLine(io.stdout, `Configured Codex for Volare: ${result.configPath}`);
          if (result.backupPath) {
            await writeLine(io.stdout, `Backup written: ${result.backupPath}`);
          }
        } else {
          await writeLine(
            io.stdout,
            `Codex is already configured for Volare: ${result.configPath}`,
          );
        }
        return 0;
      }
      case 'status': {
        const status = await dependencies.getDaemonStatus();
        if (status.running) {
          await writeLine(io.stdout, `Volare daemon is running (pid ${status.pid}).`);
        } else {
          await writeLine(io.stdout, 'Volare daemon is not running.');
        }
        await writeLine(io.stdout, `PID file: ${status.pidPath}`);
        await writeLine(io.stdout, `Logs: ${status.logPath}`);
        return status.running ? 0 : 1;
      }
      case 'stop': {
        const result = await dependencies.stopDaemon();
        if (result.stopped) {
          await writeLine(io.stdout, `Volare daemon stopped (pid ${result.pid}).`);
          return 0;
        }
        await writeLine(io.stdout, 'Volare daemon is not running.');
        return 1;
      }
      case 'logs': {
        await writeLine(io.stdout, dependencies.getDaemonPaths().logPath);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      await writeLine(io.stderr, `Error: ${error.message}`);
      await writeLine(io.stderr, usage());
      return 2;
    }
    throw error;
  }
}

export function parseCli(argv: string[]): ICliCommand {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { type: 'help' };
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    return { type: 'version' };
  }
  if (command === 'start') {
    return parseStart(rest);
  }
  if (command === 'config') {
    return parseConfig(rest);
  }
  if (command === 'status') {
    assertNoArgs(rest, 'status');
    return { type: 'status' };
  }
  if (command === 'stop') {
    assertNoArgs(rest, 'stop');
    return { type: 'stop' };
  }
  if (command === 'logs') {
    assertNoArgs(rest, 'logs');
    return { type: 'logs' };
  }
  throw new CliUsageError(
    `Unknown command: ${command}. Expected one of: start, config, status, stop, logs, help, version.`,
  );
}

function parseStart(args: string[]): Extract<ICliCommand, { type: 'start' }> {
  const env: Partial<IServerRuntimeEnv> = {};
  const daemonArgs: string[] = ['start'];
  let daemon = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === '-d' || arg === '--daemon') {
      daemon = true;
      continue;
    }
    if (arg === '--host' || arg.startsWith('--host=')) {
      const parsed = readFlagValue(args, index, '--host');
      env.VOLARE_HOST = parsed.value;
      daemonArgs.push('--host', parsed.value);
      index = parsed.index;
      continue;
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const parsed = readFlagValue(args, index, '--port');
      env.VOLARE_PORT = parsed.value;
      daemonArgs.push('--port', parsed.value);
      index = parsed.index;
      continue;
    }
    if (arg === '--state-db' || arg.startsWith('--state-db=')) {
      const parsed = readFlagValue(args, index, '--state-db');
      env.VOLARE_STATE_DB_PATH = parsed.value;
      daemonArgs.push('--state-db', parsed.value);
      index = parsed.index;
      continue;
    }
    if (arg === '--workspace-root' || arg.startsWith('--workspace-root=')) {
      const parsed = readFlagValue(args, index, '--workspace-root');
      env.VOLARE_WORKSPACE_ROOT = parsed.value;
      daemonArgs.push('--workspace-root', parsed.value);
      index = parsed.index;
      continue;
    }
    if (arg === '--projectless-workspace-root' || arg.startsWith('--projectless-workspace-root=')) {
      const parsed = readFlagValue(args, index, '--projectless-workspace-root');
      env.VOLARE_PROJECTLESS_WORKSPACE_ROOT = parsed.value;
      daemonArgs.push('--projectless-workspace-root', parsed.value);
      index = parsed.index;
      continue;
    }
    if (arg === '--log-level' || arg.startsWith('--log-level=')) {
      const parsed = readFlagValue(args, index, '--log-level');
      env.VOLARE_LOG_LEVEL = parsed.value;
      daemonArgs.push('--log-level', parsed.value);
      index = parsed.index;
      continue;
    }
    if (arg === '--copilot-permission-mode' || arg.startsWith('--copilot-permission-mode=')) {
      const parsed = readFlagValue(args, index, '--copilot-permission-mode');
      if (!isCopilotCliPermissionMode(parsed.value)) {
        throw new CliUsageError(
          `--copilot-permission-mode "${parsed.value}" is not valid. Valid modes: restricted, web, or full. Example: bunx @lachimere/volare start --copilot-permission-mode web`,
        );
      }
      env.VOLARE_COPILOT_PERMISSION_MODE = parsed.value;
      daemonArgs.push('--copilot-permission-mode', parsed.value);
      index = parsed.index;
      continue;
    }
    throw new CliUsageError(`Unknown start option: ${arg}`);
  }

  return { type: 'start', daemon, env, daemonArgs };
}

function parseConfig(args: string[]): Extract<ICliCommand, { type: 'config-codex' }> {
  const [target, ...rest] = args;
  if (target !== 'codex') {
    throw new CliUsageError('Expected config target: codex');
  }
  const options: ICodexConfigOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) {
      continue;
    }
    if (arg === '--config' || arg === '--config-path' || arg.startsWith('--config=')) {
      const parsed = readFlagValue(
        rest,
        index,
        arg === '--config-path' ? '--config-path' : '--config',
      );
      options.configPath = parsed.value;
      index = parsed.index;
      continue;
    }
    if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      const parsed = readFlagValue(rest, index, '--base-url');
      options.baseUrl = parsed.value;
      index = parsed.index;
      continue;
    }
    if (arg === '--env-key' || arg.startsWith('--env-key=')) {
      const parsed = readFlagValue(rest, index, '--env-key');
      options.envKey = parsed.value;
      index = parsed.index;
      continue;
    }
    throw new CliUsageError(`Unknown config codex option: ${arg}`);
  }
  return { type: 'config-codex', options };
}

function readFlagValue(
  args: string[],
  index: number,
  flag: string,
): { value: string; index: number } {
  const arg = args[index];
  if (!arg) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  const inlinePrefix = `${flag}=`;
  if (arg.startsWith(inlinePrefix)) {
    const value = arg.slice(inlinePrefix.length);
    if (!value) {
      throw new CliUsageError(`Missing value for ${flag}`);
    }
    return { value, index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  return { value, index: index + 1 };
}

function assertNoArgs(args: string[], command: string): void {
  if (args.length > 0) {
    throw new CliUsageError(`Unexpected argument for ${command}: ${args[0]}`);
  }
}

function defaultDependencies(): ICliDependencies {
  return {
    configureCodex,
    startRuntime: startVolareRuntime,
    installSignalHandlers: installRuntimeSignalHandlers,
    startDaemon,
    stopDaemon,
    getDaemonStatus,
    getDaemonPaths: defaultDaemonPaths,
    getEnv: () => Bun.env,
  };
}

function defaultIo(): ICliIo {
  return {
    stdout: Bun.stdout.writer(),
    stderr: Bun.stderr.writer(),
  };
}

export function defaultDaemonPaths(
  env: Record<string, string | undefined> = Bun.env,
): IDaemonPaths {
  const rootDir = env['VOLARE_HOME']?.trim() || join(homedir(), '.volare');
  return {
    rootDir,
    logPath: join(rootDir, 'logs', 'volare.log'),
    pidPath: join(rootDir, 'volare.pid'),
    stateDatabasePath: join(rootDir, 'state.sqlite'),
  };
}

async function startDaemon(
  command: Extract<ICliCommand, { type: 'start' }>,
): Promise<IDaemonStartResult> {
  const paths = defaultDaemonPaths();
  await mkdir(dirname(paths.logPath), { recursive: true });
  await mkdir(dirname(paths.pidPath), { recursive: true });
  const executable = currentExecutable();
  const env = {
    ...Bun.env,
    ...command.env,
    VOLARE_DAEMONIZED: '1',
    VOLARE_STATE_DB_PATH:
      command.env.VOLARE_STATE_DB_PATH ??
      Bun.env['VOLARE_STATE_DB_PATH'] ??
      paths.stateDatabasePath,
  };
  const stdout = openSync(paths.logPath, 'a');
  const stderr = openSync(paths.logPath, 'a');
  try {
    const child = spawn(executable.command, [...executable.argsPrefix, ...command.daemonArgs], {
      cwd: process.cwd(),
      detached: true,
      env,
      stdio: ['ignore', stdout, stderr],
    });
    if (child.pid === undefined) {
      throw new CliUsageError('Daemon process did not report a pid');
    }
    try {
      await waitForDaemonStart(child.pid, env, paths.logPath);
    } catch (error) {
      await terminateDaemonAfterStartupFailure(child.pid);
      throw error;
    }
    try {
      await writeFile(paths.pidPath, `${child.pid}\n`);
    } catch (error) {
      await terminateDaemonAfterStartupFailure(child.pid);
      throw error;
    }
    child.unref();
    return { pid: child.pid, logPath: paths.logPath, pidPath: paths.pidPath };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

function currentExecutable(): { command: string; argsPrefix: string[] } {
  const executable = Bun.argv[0];
  const script = Bun.argv[1];
  if (!executable) {
    throw new CliUsageError('Unable to locate current executable');
  }
  if (script?.endsWith('.ts') || script?.endsWith('.js')) {
    return { command: executable, argsPrefix: [script] };
  }
  return { command: executable, argsPrefix: [] };
}

async function getDaemonStatus(): Promise<IDaemonStatusResult> {
  const paths = defaultDaemonPaths();
  const pid = await readPid(paths.pidPath);
  if (pid === undefined) {
    return { running: false, pidPath: paths.pidPath, logPath: paths.logPath };
  }
  return {
    running: isProcessRunning(pid),
    pid,
    pidPath: paths.pidPath,
    logPath: paths.logPath,
  };
}

async function stopDaemon(): Promise<IDaemonStopResult> {
  const paths = defaultDaemonPaths();
  const pid = await readPid(paths.pidPath);
  if (pid === undefined) {
    return { stopped: false, pidPath: paths.pidPath };
  }
  if (isProcessRunning(pid)) {
    await terminateProcess(pid, 10_000);
  }
  await rm(paths.pidPath, { force: true });
  return { stopped: true, pid, pidPath: paths.pidPath };
}

async function waitForDaemonStart(
  pid: number,
  env: Record<string, string | undefined>,
  logPath: string,
): Promise<void> {
  const apiKey = env['VOLARE_API_KEY'];
  if (!apiKey) {
    await delay(750);
    if (!isProcessRunning(pid)) {
      throw new CliUsageError(
        `Daemon process exited before it became ready; see logs at ${logPath}`,
      );
    }
    return;
  }

  const host = env['VOLARE_HOST'] ?? '127.0.0.1';
  const port = env['VOLARE_PORT'] ?? '8000';
  const healthUrl = `http://${host}:${port}/healthz`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      throw new CliUsageError(
        `Daemon process exited before it became ready; see logs at ${logPath}`,
      );
    }
    try {
      const response = await fetch(healthUrl, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The process can be alive before Bun.serve starts listening.
    }
    await delay(100);
  }
  throw new CliUsageError(`Daemon did not become healthy at ${healthUrl}; see logs at ${logPath}`);
}

async function terminateProcess(pid: number, timeoutMs: number): Promise<void> {
  if (!isProcessRunning(pid)) {
    return;
  }
  if (!signalProcess(pid, 'SIGTERM')) {
    return;
  }
  if (await waitForProcessExit(pid, timeoutMs)) {
    return;
  }
  if (!signalProcess(pid, 'SIGKILL')) {
    return;
  }
  if (!(await waitForProcessExit(pid, 2000))) {
    throw new CliUsageError(`Daemon process ${pid} did not exit`);
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function terminateDaemonAfterStartupFailure(pid: number): Promise<void> {
  if (!isProcessRunning(pid)) {
    return;
  }
  try {
    await terminateProcess(pid, 2000);
  } catch (cleanupError) {
    process.stderr.write(
      `Warning: failed to terminate daemon process ${pid} after startup failure: ${errorMessage(cleanupError)}\n`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isProcessRunning(pid);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPid(pidPath: string): Promise<number | undefined> {
  const file = Bun.file(pidPath);
  if (!(await file.exists())) {
    return undefined;
  }
  const text = await readFile(pidPath, 'utf8');
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new CliUsageError(`Invalid daemon pid file: ${pidPath}`);
  }
  return pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ESRCH') {
      return false;
    }
    if (isSystemError(error) && error.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function usage(): string {
  return `Volare ${VERSION}

Usage:
  volare start [options]
  volare start -d [options]
  volare config codex [options]
  volare status
  volare stop
  volare logs

Start options:
  -d, --daemon                         Start in the background
      --host <host>                    Set VOLARE_HOST
      --port <port>                    Set VOLARE_PORT
      --state-db <path>                Set VOLARE_STATE_DB_PATH
      --workspace-root <path>          Set VOLARE_WORKSPACE_ROOT
      --projectless-workspace-root <path>
                                        Set VOLARE_PROJECTLESS_WORKSPACE_ROOT
      --log-level <level>              Set VOLARE_LOG_LEVEL
      --copilot-permission-mode <mode> Set VOLARE_COPILOT_PERMISSION_MODE
                                        (restricted, web, or full)

Config options:
      --config, --config-path <path>   Codex config path
      --base-url <url>                 Volare OpenAI Responses base URL
      --env-key <name>                 Codex env_key for the Volare API token

Set VOLARE_API_KEY in the environment for a stable API token. If it is omitted,
Volare generates an ephemeral startup token and prints it to stderr or the daemon log.`;
}

async function writeLine(writer: ICliWriter, text: string): Promise<void> {
  await Promise.resolve(writer.write(new TextEncoder().encode(`${text}\n`)));
}

if (import.meta.main) {
  const exitCode = await runCli(Bun.argv.slice(2));
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
