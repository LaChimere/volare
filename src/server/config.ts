import { AgentLoomError } from '../core/errors';

export interface ServerRuntimeConfigInterface {
  host: string;
  port: number;
  apiKey: string;
  generatedApiKey: boolean;
  defaultWorkspaceRoot?: string;
  allowedWorkspaceRoots?: string[];
}

export interface ServerRuntimeEnvInterface {
  AGENT_LOOM_API_KEY: string | undefined;
  AGENT_LOOM_HOST: string | undefined;
  AGENT_LOOM_PORT: string | undefined;
  AGENT_LOOM_WORKSPACE_ROOT: string | undefined;
  AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS: string | undefined;
}

export function createServerRuntimeConfig(
  env: Partial<ServerRuntimeEnvInterface> = readServerRuntimeEnv(),
): ServerRuntimeConfigInterface {
  const providedApiKey = env.AGENT_LOOM_API_KEY;
  const apiKey = providedApiKey ?? generateApiKey();
  if (providedApiKey && providedApiKey.length < 16) {
    throw new AgentLoomError(
      'invalid_api_key',
      'AGENT_LOOM_API_KEY is too short for local bearer auth',
    );
  }

  return {
    host: env.AGENT_LOOM_HOST ?? '127.0.0.1',
    port: env.AGENT_LOOM_PORT ? Number(env.AGENT_LOOM_PORT) : 8000,
    apiKey,
    generatedApiKey: !providedApiKey,
    ...(env.AGENT_LOOM_WORKSPACE_ROOT
      ? { defaultWorkspaceRoot: env.AGENT_LOOM_WORKSPACE_ROOT }
      : {}),
    ...(env.AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS
      ? {
          allowedWorkspaceRoots: env.AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS.split(':').filter(Boolean),
        }
      : {}),
  };
}

function readServerRuntimeEnv(): ServerRuntimeEnvInterface {
  return {
    AGENT_LOOM_API_KEY: Bun.env['AGENT_LOOM_API_KEY'],
    AGENT_LOOM_HOST: Bun.env['AGENT_LOOM_HOST'],
    AGENT_LOOM_PORT: Bun.env['AGENT_LOOM_PORT'],
    AGENT_LOOM_WORKSPACE_ROOT: Bun.env['AGENT_LOOM_WORKSPACE_ROOT'],
    AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS: Bun.env['AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS'],
  };
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
