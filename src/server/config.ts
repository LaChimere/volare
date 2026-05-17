import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CopilotCliPermissionMode,
  type CopilotMcpMode,
  DEFAULT_COPILOT_CLI_PERMISSION_MODE,
  DEFAULT_COPILOT_MCP_MODE,
  isCopilotCliPermissionMode,
  isCopilotMcpMode,
} from '../backends/copilot-cli/backend';
import { VolareError } from '../core/errors';
import type { LogLevel } from '../logging/logger';
import { generateVolareApiKey, isValidVolareApiKey } from './api-key';

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
  copilotMcpMode: CopilotMcpMode;
  defaultWorkspaceRoot?: string;
  allowedWorkspaceRoots?: string[];
  projectlessWorkspaceRoot: string;
}

export interface IServerRuntimeEnv {
  VOLARE_API_KEY: string | undefined;
  VOLARE_HOST: string | undefined;
  VOLARE_PORT: string | undefined;
  VOLARE_WORKSPACE_ROOT: string | undefined;
  VOLARE_PROJECTLESS_WORKSPACE_ROOT: string | undefined;
  VOLARE_ALLOWED_WORKSPACE_ROOTS: string | undefined;
  VOLARE_STATE_DB_PATH: string | undefined;
  VOLARE_CORS_MODE: string | undefined;
  VOLARE_CORS_ALLOWED_ORIGINS: string | undefined;
  VOLARE_APPROVAL_TIMEOUT_MS: string | undefined;
  VOLARE_CANCEL_TIMEOUT_MS: string | undefined;
  VOLARE_DISCONNECT_GRACE_MS: string | undefined;
  VOLARE_HTTP_IDLE_TIMEOUT_SECONDS: string | undefined;
  VOLARE_LOG_LEVEL: string | undefined;
  VOLARE_MAX_ACTIVE_SESSIONS: string | undefined;
  VOLARE_EVENT_RETENTION_DAYS: string | undefined;
  VOLARE_COPILOT_PERMISSION_MODE: string | undefined;
  VOLARE_COPILOT_MCP_MODE: string | undefined;
}

export function createServerRuntimeConfig(
  env: Partial<IServerRuntimeEnv> = readServerRuntimeEnv(),
): IServerRuntimeConfig {
  const providedApiKey = env.VOLARE_API_KEY;
  const apiKey = providedApiKey ?? generateVolareApiKey();
  if (providedApiKey !== undefined && !isValidVolareApiKey(providedApiKey)) {
    throw new VolareError(
      'invalid_api_key',
      'VOLARE_API_KEY must be at least 16 non-whitespace characters',
    );
  }
  validateCorsConfig(env);
  const defaultWorkspaceRoot = parseWorkspaceRoot(
    'VOLARE_WORKSPACE_ROOT',
    env.VOLARE_WORKSPACE_ROOT,
  );
  const allowedWorkspaceRoots = parseAllowedWorkspaceRoots(env.VOLARE_ALLOWED_WORKSPACE_ROOTS);
  const projectlessWorkspaceRoot =
    parseWorkspaceRoot(
      'VOLARE_PROJECTLESS_WORKSPACE_ROOT',
      env.VOLARE_PROJECTLESS_WORKSPACE_ROOT,
    ) ?? join(tmpdir(), 'volare-projectless-workspace');
  const eventRetentionDays = optionalIntegerInRange(
    'VOLARE_EVENT_RETENTION_DAYS',
    env.VOLARE_EVENT_RETENTION_DAYS,
    1,
    3650,
  );

  const copilotPermissionMode = parseCopilotPermissionMode(env.VOLARE_COPILOT_PERMISSION_MODE);
  const copilotMcpMode = parseCopilotMcpMode(env.VOLARE_COPILOT_MCP_MODE);
  validateCopilotMcpConfig(copilotMcpMode, copilotPermissionMode);

  return {
    host: env.VOLARE_HOST ?? '127.0.0.1',
    port: integerInRange('VOLARE_PORT', env.VOLARE_PORT, 1, 65_535, 8000),
    apiKey,
    generatedApiKey: !providedApiKey,
    stateDatabasePath: env.VOLARE_STATE_DB_PATH ?? '.volare/state.sqlite',
    corsMode: 'disabled',
    approvalTimeoutMs: integerInRange(
      'VOLARE_APPROVAL_TIMEOUT_MS',
      env.VOLARE_APPROVAL_TIMEOUT_MS,
      1,
      600_000,
      60_000,
    ),
    cancelTimeoutMs: integerInRange(
      'VOLARE_CANCEL_TIMEOUT_MS',
      env.VOLARE_CANCEL_TIMEOUT_MS,
      1,
      600_000,
      10_000,
    ),
    disconnectGraceMs: integerInRange(
      'VOLARE_DISCONNECT_GRACE_MS',
      env.VOLARE_DISCONNECT_GRACE_MS,
      0,
      60_000,
      5000,
    ),
    httpIdleTimeoutSeconds: integerInRange(
      'VOLARE_HTTP_IDLE_TIMEOUT_SECONDS',
      env.VOLARE_HTTP_IDLE_TIMEOUT_SECONDS,
      0,
      255,
      0,
    ),
    logLevel: parseLogLevel(env.VOLARE_LOG_LEVEL),
    copilotPermissionMode,
    copilotMcpMode,
    maxActiveSessions: integerInRange(
      'VOLARE_MAX_ACTIVE_SESSIONS',
      env.VOLARE_MAX_ACTIVE_SESSIONS,
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
    VOLARE_API_KEY: Bun.env['VOLARE_API_KEY'],
    VOLARE_HOST: Bun.env['VOLARE_HOST'],
    VOLARE_PORT: Bun.env['VOLARE_PORT'],
    VOLARE_WORKSPACE_ROOT: Bun.env['VOLARE_WORKSPACE_ROOT'],
    VOLARE_PROJECTLESS_WORKSPACE_ROOT: Bun.env['VOLARE_PROJECTLESS_WORKSPACE_ROOT'],
    VOLARE_ALLOWED_WORKSPACE_ROOTS: Bun.env['VOLARE_ALLOWED_WORKSPACE_ROOTS'],
    VOLARE_STATE_DB_PATH: Bun.env['VOLARE_STATE_DB_PATH'],
    VOLARE_CORS_MODE: Bun.env['VOLARE_CORS_MODE'],
    VOLARE_CORS_ALLOWED_ORIGINS: Bun.env['VOLARE_CORS_ALLOWED_ORIGINS'],
    VOLARE_APPROVAL_TIMEOUT_MS: Bun.env['VOLARE_APPROVAL_TIMEOUT_MS'],
    VOLARE_CANCEL_TIMEOUT_MS: Bun.env['VOLARE_CANCEL_TIMEOUT_MS'],
    VOLARE_DISCONNECT_GRACE_MS: Bun.env['VOLARE_DISCONNECT_GRACE_MS'],
    VOLARE_HTTP_IDLE_TIMEOUT_SECONDS: Bun.env['VOLARE_HTTP_IDLE_TIMEOUT_SECONDS'],
    VOLARE_LOG_LEVEL: Bun.env['VOLARE_LOG_LEVEL'],
    VOLARE_MAX_ACTIVE_SESSIONS: Bun.env['VOLARE_MAX_ACTIVE_SESSIONS'],
    VOLARE_EVENT_RETENTION_DAYS: Bun.env['VOLARE_EVENT_RETENTION_DAYS'],
    VOLARE_COPILOT_PERMISSION_MODE: Bun.env['VOLARE_COPILOT_PERMISSION_MODE'],
    VOLARE_COPILOT_MCP_MODE: Bun.env['VOLARE_COPILOT_MCP_MODE'],
  };
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value?.trim() ?? 'info';
  if (isLogLevel(level)) {
    return level;
  }
  throw new VolareError(
    'invalid_config',
    'VOLARE_LOG_LEVEL must be one of trace, debug, info, warn, error, fatal, or silent',
  );
}

function isLogLevel(value: string): value is LogLevel {
  return ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(value);
}

function parseCopilotPermissionMode(value: string | undefined): CopilotCliPermissionMode {
  const mode = value?.trim() ?? DEFAULT_COPILOT_CLI_PERMISSION_MODE;
  if (isCopilotCliPermissionMode(mode)) {
    return mode;
  }
  throw new VolareError(
    'invalid_config',
    'VOLARE_COPILOT_PERMISSION_MODE must be restricted, web, or full',
  );
}

function parseCopilotMcpMode(value: string | undefined): CopilotMcpMode {
  const mode = value?.trim() ?? DEFAULT_COPILOT_MCP_MODE;
  if (isCopilotMcpMode(mode)) {
    return mode;
  }
  throw new VolareError('invalid_config', 'VOLARE_COPILOT_MCP_MODE must be disabled or unmediated');
}

function validateCopilotMcpConfig(
  mcpMode: CopilotMcpMode,
  permissionMode: CopilotCliPermissionMode,
): void {
  if (mcpMode === 'unmediated' && permissionMode === 'restricted') {
    throw new VolareError(
      'invalid_config',
      'VOLARE_COPILOT_MCP_MODE=unmediated requires VOLARE_COPILOT_PERMISSION_MODE to be web or full',
    );
  }
}

function validateCorsConfig(env: Partial<IServerRuntimeEnv>): void {
  const mode = env.VOLARE_CORS_MODE?.trim() ?? 'disabled';
  const origins = splitList(env.VOLARE_CORS_ALLOWED_ORIGINS);
  if (mode !== 'disabled') {
    throw new VolareError('invalid_config', 'CORS browser mode is not supported in the MVP');
  }
  if (origins.includes('*')) {
    throw new VolareError('invalid_config', 'Wildcard CORS origins are not allowed');
  }
}

function parseWorkspaceRoot(name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*') {
    throw new VolareError('invalid_config', `${name} must be a concrete workspace path`);
  }
  return trimmed;
}

function parseAllowedWorkspaceRoots(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const roots = splitList(value);
  if (roots.length === 0 || roots.some((root) => root === '*')) {
    throw new VolareError(
      'invalid_config',
      'VOLARE_ALLOWED_WORKSPACE_ROOTS must contain only concrete workspace paths',
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
    throw new VolareError(
      'invalid_config',
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}
