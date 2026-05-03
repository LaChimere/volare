import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CopilotCliPermissionMode } from '../backends/copilot-cli/backend';
import { AgentLoomError } from '../core/errors';
import type { LogLevel } from '../logging/logger';

export interface IServerRuntimeConfig {
  host: string;
  port: number;
  apiKey: string;
  generatedApiKey: boolean;
  stateDatabasePath: string;
  corsMode: 'disabled';
  approvalTimeoutMs: number;
  cancelTimeoutMs: number;
  disconnectGraceMs: number;
  httpIdleTimeoutSeconds: number;
  logLevel: LogLevel;
  maxActiveSessions: number;
  eventRetentionDays?: number;
  copilotPermissionMode: CopilotCliPermissionMode;
  defaultWorkspaceRoot?: string;
  allowedWorkspaceRoots?: string[];
  projectlessWorkspaceRoot: string;
}

export interface IServerRuntimeEnv {
  AGENT_LOOM_API_KEY: string | undefined;
  AGENT_LOOM_HOST: string | undefined;
  AGENT_LOOM_PORT: string | undefined;
  AGENT_LOOM_WORKSPACE_ROOT: string | undefined;
  AGENT_LOOM_PROJECTLESS_WORKSPACE_ROOT: string | undefined;
  AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS: string | undefined;
  AGENT_LOOM_STATE_DB_PATH: string | undefined;
  AGENT_LOOM_CORS_MODE: string | undefined;
  AGENT_LOOM_CORS_ALLOWED_ORIGINS: string | undefined;
  AGENT_LOOM_APPROVAL_TIMEOUT_MS: string | undefined;
  AGENT_LOOM_CANCEL_TIMEOUT_MS: string | undefined;
  AGENT_LOOM_DISCONNECT_GRACE_MS: string | undefined;
  AGENT_LOOM_HTTP_IDLE_TIMEOUT_SECONDS: string | undefined;
  AGENT_LOOM_LOG_LEVEL: string | undefined;
  AGENT_LOOM_MAX_ACTIVE_SESSIONS: string | undefined;
  AGENT_LOOM_EVENT_RETENTION_DAYS: string | undefined;
  AGENT_LOOM_COPILOT_PERMISSION_MODE: string | undefined;
}

export function createServerRuntimeConfig(
  env: Partial<IServerRuntimeEnv> = readServerRuntimeEnv(),
): IServerRuntimeConfig {
  const providedApiKey = env.AGENT_LOOM_API_KEY;
  const apiKey = providedApiKey ?? generateApiKey();
  if (
    providedApiKey !== undefined &&
    (providedApiKey.trim().length < 16 || /\s/.test(providedApiKey))
  ) {
    throw new AgentLoomError(
      'invalid_api_key',
      'AGENT_LOOM_API_KEY must be at least 16 non-whitespace characters',
    );
  }
  validateCorsConfig(env);
  const defaultWorkspaceRoot = parseWorkspaceRoot(
    'AGENT_LOOM_WORKSPACE_ROOT',
    env.AGENT_LOOM_WORKSPACE_ROOT,
  );
  const allowedWorkspaceRoots = parseAllowedWorkspaceRoots(env.AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS);
  const projectlessWorkspaceRoot =
    parseWorkspaceRoot(
      'AGENT_LOOM_PROJECTLESS_WORKSPACE_ROOT',
      env.AGENT_LOOM_PROJECTLESS_WORKSPACE_ROOT,
    ) ?? join(tmpdir(), 'al-projectless-workspace');
  const eventRetentionDays = optionalIntegerInRange(
    'AGENT_LOOM_EVENT_RETENTION_DAYS',
    env.AGENT_LOOM_EVENT_RETENTION_DAYS,
    1,
    3650,
  );

  return {
    host: env.AGENT_LOOM_HOST ?? '127.0.0.1',
    port: integerInRange('AGENT_LOOM_PORT', env.AGENT_LOOM_PORT, 1, 65_535, 8000),
    apiKey,
    generatedApiKey: !providedApiKey,
    stateDatabasePath: env.AGENT_LOOM_STATE_DB_PATH ?? '.agent-loom/state.sqlite',
    corsMode: 'disabled',
    approvalTimeoutMs: integerInRange(
      'AGENT_LOOM_APPROVAL_TIMEOUT_MS',
      env.AGENT_LOOM_APPROVAL_TIMEOUT_MS,
      1,
      600_000,
      60_000,
    ),
    cancelTimeoutMs: integerInRange(
      'AGENT_LOOM_CANCEL_TIMEOUT_MS',
      env.AGENT_LOOM_CANCEL_TIMEOUT_MS,
      1,
      600_000,
      10_000,
    ),
    disconnectGraceMs: integerInRange(
      'AGENT_LOOM_DISCONNECT_GRACE_MS',
      env.AGENT_LOOM_DISCONNECT_GRACE_MS,
      0,
      60_000,
      5000,
    ),
    httpIdleTimeoutSeconds: integerInRange(
      'AGENT_LOOM_HTTP_IDLE_TIMEOUT_SECONDS',
      env.AGENT_LOOM_HTTP_IDLE_TIMEOUT_SECONDS,
      0,
      255,
      0,
    ),
    logLevel: parseLogLevel(env.AGENT_LOOM_LOG_LEVEL),
    copilotPermissionMode: parseCopilotPermissionMode(env.AGENT_LOOM_COPILOT_PERMISSION_MODE),
    maxActiveSessions: integerInRange(
      'AGENT_LOOM_MAX_ACTIVE_SESSIONS',
      env.AGENT_LOOM_MAX_ACTIVE_SESSIONS,
      1,
      1000,
      10,
    ),
    ...(eventRetentionDays ? { eventRetentionDays } : {}),
    ...(defaultWorkspaceRoot ? { defaultWorkspaceRoot } : {}),
    ...(allowedWorkspaceRoots ? { allowedWorkspaceRoots } : {}),
    projectlessWorkspaceRoot,
  };
}

export function readServerRuntimeEnv(): IServerRuntimeEnv {
  return {
    AGENT_LOOM_API_KEY: Bun.env['AGENT_LOOM_API_KEY'],
    AGENT_LOOM_HOST: Bun.env['AGENT_LOOM_HOST'],
    AGENT_LOOM_PORT: Bun.env['AGENT_LOOM_PORT'],
    AGENT_LOOM_WORKSPACE_ROOT: Bun.env['AGENT_LOOM_WORKSPACE_ROOT'],
    AGENT_LOOM_PROJECTLESS_WORKSPACE_ROOT: Bun.env['AGENT_LOOM_PROJECTLESS_WORKSPACE_ROOT'],
    AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS: Bun.env['AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS'],
    AGENT_LOOM_STATE_DB_PATH: Bun.env['AGENT_LOOM_STATE_DB_PATH'],
    AGENT_LOOM_CORS_MODE: Bun.env['AGENT_LOOM_CORS_MODE'],
    AGENT_LOOM_CORS_ALLOWED_ORIGINS: Bun.env['AGENT_LOOM_CORS_ALLOWED_ORIGINS'],
    AGENT_LOOM_APPROVAL_TIMEOUT_MS: Bun.env['AGENT_LOOM_APPROVAL_TIMEOUT_MS'],
    AGENT_LOOM_CANCEL_TIMEOUT_MS: Bun.env['AGENT_LOOM_CANCEL_TIMEOUT_MS'],
    AGENT_LOOM_DISCONNECT_GRACE_MS: Bun.env['AGENT_LOOM_DISCONNECT_GRACE_MS'],
    AGENT_LOOM_HTTP_IDLE_TIMEOUT_SECONDS: Bun.env['AGENT_LOOM_HTTP_IDLE_TIMEOUT_SECONDS'],
    AGENT_LOOM_LOG_LEVEL: Bun.env['AGENT_LOOM_LOG_LEVEL'],
    AGENT_LOOM_MAX_ACTIVE_SESSIONS: Bun.env['AGENT_LOOM_MAX_ACTIVE_SESSIONS'],
    AGENT_LOOM_EVENT_RETENTION_DAYS: Bun.env['AGENT_LOOM_EVENT_RETENTION_DAYS'],
    AGENT_LOOM_COPILOT_PERMISSION_MODE: Bun.env['AGENT_LOOM_COPILOT_PERMISSION_MODE'],
  };
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value?.trim() ?? 'info';
  if (isLogLevel(level)) {
    return level;
  }
  throw new AgentLoomError(
    'invalid_config',
    'AGENT_LOOM_LOG_LEVEL must be one of trace, debug, info, warn, error, fatal, or silent',
  );
}

function isLogLevel(value: string): value is LogLevel {
  return ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(value);
}

function parseCopilotPermissionMode(value: string | undefined): CopilotCliPermissionMode {
  const mode = value?.trim() ?? 'full';
  if (mode === 'restricted' || mode === 'web' || mode === 'full') {
    return mode;
  }
  throw new AgentLoomError(
    'invalid_config',
    'AGENT_LOOM_COPILOT_PERMISSION_MODE must be restricted, web, or full',
  );
}

function validateCorsConfig(env: Partial<IServerRuntimeEnv>): void {
  const mode = env.AGENT_LOOM_CORS_MODE?.trim() ?? 'disabled';
  const origins = splitList(env.AGENT_LOOM_CORS_ALLOWED_ORIGINS);
  if (mode !== 'disabled') {
    throw new AgentLoomError('invalid_config', 'CORS browser mode is not supported in the MVP');
  }
  if (origins.includes('*')) {
    throw new AgentLoomError('invalid_config', 'Wildcard CORS origins are not allowed');
  }
}

function parseWorkspaceRoot(name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*') {
    throw new AgentLoomError('invalid_config', `${name} must be a concrete workspace path`);
  }
  return trimmed;
}

function parseAllowedWorkspaceRoots(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const roots = splitList(value);
  if (roots.length === 0 || roots.some((root) => root === '*')) {
    throw new AgentLoomError(
      'invalid_config',
      'AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS must contain only concrete workspace paths',
    );
  }
  return roots;
}

function splitList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function integerInRange(
  name: string,
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return optionalIntegerInRange(name, value, minimum, maximum) ?? fallback;
}

function optionalIntegerInRange(
  name: string,
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AgentLoomError(
      'invalid_config',
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}
