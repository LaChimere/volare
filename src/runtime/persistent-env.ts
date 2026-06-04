import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isValidVolareApiKey, VOLARE_API_KEY_ENV } from '../server/api-key';
import type { IServerRuntimeEnv } from '../server/config';

export interface IPersistentRuntimeEnv {
  VOLARE_API_KEY?: string;
  SSL_CERT_FILE?: string;
  REQUESTS_CA_BUNDLE?: string;
  CURL_CA_BUNDLE?: string;
}

const PERSISTED_ENV_NAMES = [
  'VOLARE_API_KEY',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;

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
  const values = await readPersistentEnvValues(env);
  return values;
}

export async function readPersistentApiKey(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const envPath = defaultPersistentEnvPath(env);
  const file = Bun.file(envPath);
  if (!(await file.exists())) {
    return undefined;
  }
  const value = parsePersistentEnvValues(await readFile(envPath, 'utf8')).VOLARE_API_KEY;
  if (value !== undefined && !isValidVolareApiKey(value)) {
    throw new Error(
      `${VOLARE_API_KEY_ENV} in ${envPath} must be at least 16 non-whitespace characters`,
    );
  }
  return value;
}

export async function readPersistentEnvValues(
  env: Record<string, string | undefined> = process.env,
): Promise<IPersistentRuntimeEnv> {
  const envPath = defaultPersistentEnvPath(env);
  const file = Bun.file(envPath);
  if (!(await file.exists())) {
    return {};
  }
  const values = parsePersistentEnvValues(await readFile(envPath, 'utf8'));
  const apiKey = values.VOLARE_API_KEY;
  if (apiKey !== undefined && !isValidVolareApiKey(apiKey)) {
    throw new Error(
      `${VOLARE_API_KEY_ENV} in ${envPath} must be at least 16 non-whitespace characters`,
    );
  }
  return values;
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
  const existing = await readPersistentEnvValues(env);
  const next: IPersistentRuntimeEnv = { ...existing, VOLARE_API_KEY: apiKey };
  await writeFile(envPath, formatPersistentEnv(next), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(envPath, 0o600);
  return envPath;
}

function formatPersistentEnv(values: IPersistentRuntimeEnv): string {
  const lines: string[] = [];
  for (const name of PERSISTED_ENV_NAMES) {
    const value = values[name];
    if (value !== undefined) {
      lines.push(`export ${name}="${escapeEnvValue(value)}"`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function escapeEnvValue(value: string): string {
  return value.replaceAll(/["\\$`]/g, (character) => `\\${character}`);
}

function parsePersistentEnvValues(content: string): IPersistentRuntimeEnv {
  const values: IPersistentRuntimeEnv = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s#]+))/,
    );
    if (!match) {
      continue;
    }
    const key = match?.[1];
    if (!isPersistedEnvName(key)) {
      continue;
    }
    if (match[2] !== undefined) {
      values[key] = unescapeDoubleQuotedEnvValue(match[2]);
    } else {
      values[key] = match?.[3] ?? match?.[4] ?? '';
    }
  }
  return values;
}

function unescapeDoubleQuotedEnvValue(value: string): string {
  return value.replaceAll(/\\(["\\$`])/g, '$1');
}

function isPersistedEnvName(value: string | undefined): value is keyof IPersistentRuntimeEnv {
  return PERSISTED_ENV_NAMES.includes(value as keyof IPersistentRuntimeEnv);
}
