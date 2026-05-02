import { AgentLoomError } from '../core/errors';

export interface ServerRuntimeConfigInterface {
  host: string;
  port: number;
  apiKey: string;
  generatedApiKey: boolean;
  defaultWorkspaceRoot?: string;
  allowedWorkspaceRoots?: string[];
}

export function createServerRuntimeConfig(
  env: Record<string, string | undefined> = Bun.env,
): ServerRuntimeConfigInterface {
  const providedApiKey = env['AGENT_LOOM_API_KEY'];
  const apiKey = providedApiKey ?? generateApiKey();
  if (providedApiKey && providedApiKey.length < 16) {
    throw new AgentLoomError(
      'invalid_api_key',
      'AGENT_LOOM_API_KEY is too short for local bearer auth',
    );
  }

  return {
    host: env['AGENT_LOOM_HOST'] ?? '127.0.0.1',
    port: env['AGENT_LOOM_PORT'] ? Number(env['AGENT_LOOM_PORT']) : 8000,
    apiKey,
    generatedApiKey: !providedApiKey,
    ...(env['AGENT_LOOM_WORKSPACE_ROOT']
      ? { defaultWorkspaceRoot: env['AGENT_LOOM_WORKSPACE_ROOT'] }
      : {}),
    ...(env['AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS']
      ? {
          allowedWorkspaceRoots: env['AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS']
            .split(':')
            .filter(Boolean),
        }
      : {}),
  };
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
