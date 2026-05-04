import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_PROFILE = 'volare';
const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/openai/v1';
const DEFAULT_ENV_KEY = 'VOLARE_API_KEY';

export interface ICodexConfigOptions {
  configPath?: string;
  baseUrl?: string;
  envKey?: string;
  backupSuffix?: string;
}

export interface ICodexConfigResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
}

export async function configureCodex(
  options: ICodexConfigOptions = {},
): Promise<ICodexConfigResult> {
  const configPath = options.configPath ?? defaultConfigPath();
  const existing = await readTextIfExists(configPath);
  const next = buildCodexConfig(existing, {
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    envKey: options.envKey ?? DEFAULT_ENV_KEY,
  });

  if (existing === next) {
    return { configPath, changed: false };
  }

  await mkdir(dirname(configPath), { recursive: true });
  const backupPath =
    existing.length > 0
      ? `${configPath}.volare-backup-${options.backupSuffix ?? backupSuffix()}`
      : undefined;
  if (backupPath) {
    await Bun.write(backupPath, existing);
  }
  await Bun.write(configPath, next);
  return {
    configPath,
    changed: true,
    ...(backupPath ? { backupPath } : {}),
  };
}

export function buildCodexConfig(
  existing: string,
  options: { baseUrl?: string; envKey?: string } = {},
): string {
  const baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const envKey = validateEnvKey(options.envKey ?? DEFAULT_ENV_KEY);
  const withoutManagedSections = removeSection(
    removeSection(existing, `[model_providers.${DEFAULT_PROFILE}]`),
    `[profiles.${DEFAULT_PROFILE}]`,
  );
  const withDefaults = setTopLevelKeys(withoutManagedSections, [
    ['profile', DEFAULT_PROFILE],
    ['model_provider', DEFAULT_PROFILE],
    ['model', DEFAULT_MODEL],
  ]);
  return `${trimTrailingWhitespace(withDefaults)}

[model_providers.${DEFAULT_PROFILE}]
name = "Volare"
base_url = "${escapeTomlString(baseUrl)}"
wire_api = "responses"
env_key = "${escapeTomlString(envKey)}"
requires_openai_auth = true
supports_websockets = false

[profiles.${DEFAULT_PROFILE}]
model_provider = "${DEFAULT_PROFILE}"
model = "${DEFAULT_MODEL}"
`;
}

function setTopLevelKeys(content: string, entries: Array<[string, string]>): string {
  const lines = content.split(/\r?\n/);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const boundary = firstSectionIndex >= 0 ? firstSectionIndex : lines.length;
  const topLevel = lines.slice(0, boundary);
  const rest = lines.slice(boundary);

  for (const [key, value] of entries) {
    const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    const replacement = `${key} = "${escapeTomlString(value)}"`;
    const index = topLevel.findIndex((line) => keyPattern.test(line));
    if (index >= 0) {
      topLevel[index] = replacement;
    } else {
      topLevel.push(replacement);
    }
  }

  return [...topLevel, ...rest].join('\n');
}

function removeSection(content: string, sectionHeader: string): string {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === sectionHeader) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) {
      skipping = false;
    }
    if (!skipping) {
      output.push(line);
    }
  }

  return output.join('\n');
}

function trimTrailingWhitespace(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n+$/, '');
}

function escapeTomlString(value: string): string {
  if (
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error('TOML string values must not contain control characters');
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error('Volare Codex base URL must be a valid URL', { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Volare Codex base URL must use http or https');
  }
  return value;
}

function validateEnvKey(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('Volare Codex env key must be a valid environment variable name');
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readTextIfExists(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : '';
}

function defaultConfigPath(): string {
  const codexHome = Bun.env['CODEX_HOME'];
  if (codexHome) {
    return join(codexHome, 'config.toml');
  }
  const home = Bun.env['HOME'];
  if (!home) {
    throw new Error('HOME or CODEX_HOME must be set to locate Codex config');
  }
  return join(home, '.codex', 'config.toml');
}

function backupSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

if (import.meta.main) {
  const result = await configureCodex();
  if (result.changed) {
    console.log(`Configured Codex for Volare: ${result.configPath}`);
    if (result.backupPath) {
      console.log(`Backup written: ${result.backupPath}`);
    }
  } else {
    console.log(`Codex is already configured for Volare: ${result.configPath}`);
  }
}
