import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isValidVolareApiKey, VOLARE_API_KEY_ENV } from '../server/api-key';
import type { IServerRuntimeEnv } from '../server/config';

export interface IPersistentRuntimeEnv {
  VOLARE_API_KEY?: string;
}

export function defaultVolareHome(env: Record<string, string | undefined> = process.env): string {
  return env['VOLARE_HOME']?.trim() || join(homedir(), '.volare');
}

export function defaultPersistentEnvPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(defaultVolareHome(env), 'env');
}

export async function readPersistentRuntimeEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<Partial<IServerRuntimeEnv>> {
  const apiKey = await readPersistentApiKey(env);
  return apiKey ? { VOLARE_API_KEY: apiKey } : {};
}

export async function readPersistentApiKey(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const envPath = defaultPersistentEnvPath(env);
  const file = Bun.file(envPath);
  if (!(await file.exists())) {
    return undefined;
  }
  const value = parsePersistentApiKey(await readFile(envPath, 'utf8'));
  if (value !== undefined && !isValidVolareApiKey(value)) {
    throw new Error(
      `${VOLARE_API_KEY_ENV} in ${envPath} must be at least 16 non-whitespace characters`,
    );
  }
  return value;
}

export async function writePersistentApiKey(
  apiKey: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (!isValidVolareApiKey(apiKey)) {
    throw new Error(`${VOLARE_API_KEY_ENV} must be at least 16 non-whitespace characters`);
  }
  const envPath = defaultPersistentEnvPath(env);
  const envDir = dirname(envPath);
  await mkdir(envDir, { recursive: true });
  await chmod(envDir, 0o700);
  await writeFile(envPath, `export ${VOLARE_API_KEY_ENV}="${apiKey}"\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(envPath, 0o600);
  return envPath;
}

function parsePersistentApiKey(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?VOLARE_API_KEY\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/,
    );
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
