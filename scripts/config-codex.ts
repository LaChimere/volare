import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_PROFILE = 'agent-loom';
const DEFAULT_MODEL = 'copilot-agent';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/openai/v1';
const DEFAULT_ENV_KEY = 'AGENT_LOOM_API_KEY';

export interface CodexConfigOptionsInterface {
  configPath?: string;
  baseUrl?: string;
  envKey?: string;
  backupSuffix?: string;
}

export interface CodexConfigResultInterface {
  configPath: string;
  changed: boolean;
  backupPath?: string;
}

export async function configureCodex(
  options: CodexConfigOptionsInterface = {},
): Promise<CodexConfigResultInterface> {
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
      ? `${configPath}.agent-loom-backup-${options.backupSuffix ?? backupSuffix()}`
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
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const envKey = options.envKey ?? DEFAULT_ENV_KEY;
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
name = "Agent Loom"
base_url = "${escapeTomlString(baseUrl)}"
wire_api = "responses"
env_key = "${escapeTomlString(envKey)}"
requires_openai_auth = false
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
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
    console.log(`Configured Codex for Agent Loom: ${result.configPath}`);
    if (result.backupPath) {
      console.log(`Backup written: ${result.backupPath}`);
    }
  } else {
    console.log(`Codex is already configured for Agent Loom: ${result.configPath}`);
  }
}
