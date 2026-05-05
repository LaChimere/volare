import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_PROFILE = 'volare';
const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/openai/v1';
const DEFAULT_ENV_KEY = 'VOLARE_API_KEY';
const MANAGED_BLOCK_START = '# >>> volare managed';
const MANAGED_BLOCK_END = '# <<< volare managed';
const DEFAULT_BACKUP_LIMIT = 10;

export type ICodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ICodexConfigIssueSeverity = 'warning' | 'error';

export interface ICodexConfigIssue {
  code: string;
  severity: ICodexConfigIssueSeverity;
  message: string;
}

export interface ICodexConfigOptions {
  configPath?: string;
  baseUrl?: string;
  envKey?: string;
  reasoningEffort?: ICodexReasoningEffort;
  backupSuffix?: string;
  backupLimit?: number;
}

export interface ICodexConfigResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
}

export interface ICodexConfigInspection {
  configPath: string;
  healthy: boolean;
  issues: ICodexConfigIssue[];
}

export async function configureCodex(
  options: ICodexConfigOptions = {},
): Promise<ICodexConfigResult> {
  const configPath = options.configPath ?? defaultConfigPath();
  const existing = await readTextIfExists(configPath);
  const next = buildCodexConfig(existing, {
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    envKey: options.envKey ?? DEFAULT_ENV_KEY,
    reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  });
  validateGeneratedToml(next);

  if (existing === next) {
    return { configPath, changed: false };
  }

  await mkdir(dirname(configPath), { recursive: true });
  const backupPath = existing.length > 0 ? backupPathFor(configPath, options) : undefined;
  if (backupPath) {
    await mkdir(dirname(backupPath), { recursive: true });
    await Bun.write(backupPath, existing);
    await pruneBackups(dirname(backupPath), options.backupLimit ?? DEFAULT_BACKUP_LIMIT);
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
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
  } = {},
): string {
  const baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const envKey = validateEnvKey(options.envKey ?? DEFAULT_ENV_KEY);
  const reasoningEffort = validateReasoningEffort(
    options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  const managedBlockResult = removeManagedBlock(existing);
  if (managedBlockResult.unbalancedStart) {
    throw new Error(
      'Volare managed Codex config block is missing its end marker; run "volare config codex doctor" and fix the config before repair.',
    );
  }
  const withoutManagedBlock = managedBlockResult.content;
  const withoutManagedSections = removeLegacyVolareSections(
    removeSection(
      removeSection(withoutManagedBlock, `[model_providers.${DEFAULT_PROFILE}]`),
      `[profiles.${DEFAULT_PROFILE}]`,
    ),
  );
  const withDefaults = setTopLevelKeys(withoutManagedSections, [
    ['profile', DEFAULT_PROFILE],
    ['model_provider', DEFAULT_PROFILE],
    ['model', DEFAULT_MODEL],
    ['model_reasoning_effort', reasoningEffort],
  ]);
  return `${trimTrailingWhitespace(withDefaults)}

${managedBlock({ baseUrl, envKey, reasoningEffort })}`;
}

export async function inspectCodexConfig(
  options: ICodexConfigOptions = {},
): Promise<ICodexConfigInspection> {
  const configPath = options.configPath ?? defaultConfigPath();
  const existing = await readTextIfExists(configPath);
  return {
    configPath,
    ...inspectCodexConfigText(existing, options),
  };
}

export function inspectCodexConfigText(
  existing: string,
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
  } = {},
): Omit<ICodexConfigInspection, 'configPath'> {
  const issues: ICodexConfigIssue[] = [];
  const managedBlockResult = removeManagedBlock(existing);
  const outsideManagedBlock = managedBlockResult.content;

  if (existing.trim().length === 0) {
    issues.push({
      code: 'missing-config',
      severity: 'warning',
      message: 'Codex config does not exist yet; run "volare config codex" to create it.',
    });
  }

  if (managedBlockResult.unbalancedStart) {
    issues.push({
      code: 'managed-block-unclosed',
      severity: 'error',
      message: 'Volare managed block start marker is missing its end marker.',
    });
    return {
      healthy: false,
      issues,
    };
  }

  const desired = buildCodexConfig(existing, options);
  if (!isValidToml(desired)) {
    issues.push({
      code: 'codex-config-invalid-toml',
      severity: 'error',
      message:
        'Codex config would remain invalid after Volare repair; fix non-Volare TOML syntax or duplicate sections.',
    });
  }

  if (!managedBlockResult.removed) {
    issues.push({
      code: 'managed-block-missing',
      severity: 'warning',
      message: 'Volare config is not in a bounded managed block.',
    });
  }

  if (hasSection(outsideManagedBlock, `[model_providers.${DEFAULT_PROFILE}]`)) {
    issues.push({
      code: 'unmanaged-volare-provider',
      severity: 'warning',
      message: 'Found an unmanaged Volare model provider section.',
    });
  }

  if (hasSection(outsideManagedBlock, `[profiles.${DEFAULT_PROFILE}]`)) {
    issues.push({
      code: 'unmanaged-volare-profile',
      severity: 'warning',
      message: 'Found an unmanaged Volare profile section.',
    });
  }

  if (
    hasSection(outsideManagedBlock, '[model_providers.agent-loom]') ||
    hasSection(outsideManagedBlock, '[profiles.agent-loom]')
  ) {
    issues.push({
      code: 'legacy-agent-loom-section',
      severity: 'warning',
      message: 'Found legacy Agent Loom Codex sections that Volare can remove during repair.',
    });
  }

  const expectedReasoningEffort = validateReasoningEffort(
    options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  addTopLevelDriftIssue(issues, existing, 'profile', DEFAULT_PROFILE);
  addTopLevelDriftIssue(issues, existing, 'model_provider', DEFAULT_PROFILE);
  addTopLevelDriftIssue(issues, existing, 'model', DEFAULT_MODEL);
  addTopLevelDriftIssue(issues, existing, 'model_reasoning_effort', expectedReasoningEffort);

  if (existing !== desired && issues.length === 0) {
    issues.push({
      code: 'volare-config-drift',
      severity: 'warning',
      message: 'Volare-owned Codex config differs from the current desired config.',
    });
  }

  return {
    healthy: issues.length === 0,
    issues,
  };
}

function managedBlock(options: {
  baseUrl: string;
  envKey: string;
  reasoningEffort: ICodexReasoningEffort;
}): string {
  return `${MANAGED_BLOCK_START}
[model_providers.${DEFAULT_PROFILE}]
name = "Volare"
base_url = "${escapeTomlString(options.baseUrl)}"
wire_api = "responses"
env_key = "${escapeTomlString(options.envKey)}"
requires_openai_auth = true
supports_websockets = false

[profiles.${DEFAULT_PROFILE}]
model_provider = "${DEFAULT_PROFILE}"
model = "${DEFAULT_MODEL}"
model_reasoning_effort = "${escapeTomlString(options.reasoningEffort)}"
${MANAGED_BLOCK_END}
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

function removeManagedBlock(content: string): {
  content: string;
  removed: boolean;
  unbalancedStart: boolean;
} {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  let removed = false;
  let unbalancedStart = false;

  for (const line of lines) {
    if (line.trim() === MANAGED_BLOCK_START) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping && line.trim() === MANAGED_BLOCK_END) {
      skipping = false;
      continue;
    }
    if (!skipping) {
      output.push(line);
    }
  }

  if (skipping) {
    unbalancedStart = true;
  }

  return { content: output.join('\n'), removed, unbalancedStart };
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

function removeLegacyVolareSections(content: string): string {
  const withoutLegacyProvider = removeSectionIf(
    content,
    '[model_providers.agent-loom]',
    isLegacyAgentLoomProvider,
  );
  return removeSectionIf(withoutLegacyProvider, '[profiles.agent-loom]', isLegacyAgentLoomProfile);
}

function removeSectionIf(
  content: string,
  sectionHeader: string,
  shouldRemove: (sectionLines: string[]) => boolean,
): string {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    if (line?.trim() !== sectionHeader) {
      if (line !== undefined) {
        output.push(line);
      }
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < lines.length && !/^\s*\[/.test(lines[index] ?? '')) {
      index += 1;
    }
    const sectionLines = lines.slice(start, index);
    if (!shouldRemove(sectionLines)) {
      output.push(...sectionLines);
    }
  }

  return output.join('\n');
}

function isLegacyAgentLoomProvider(sectionLines: string[]): boolean {
  const section = sectionLines.join('\n');
  return (
    /\bname\s*=\s*"Agent Loom"/.test(section) ||
    /\benv_key\s*=\s*"VOLARE_API_KEY"/.test(section) ||
    /\bbase_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/openai\/v1"/.test(section)
  );
}

function isLegacyAgentLoomProfile(sectionLines: string[]): boolean {
  const section = sectionLines.join('\n');
  return (
    /\bmodel_provider\s*=\s*"agent-loom"/.test(section) ||
    /\bmodel\s*=\s*"copilot-agent"/.test(section)
  );
}

function hasSection(content: string, sectionHeader: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === sectionHeader);
}

function addTopLevelDriftIssue(
  issues: ICodexConfigIssue[],
  content: string,
  key: string,
  expected: string,
): void {
  const actual = topLevelValue(content, key);
  if (actual === undefined || actual === expected) {
    return;
  }
  issues.push({
    code: `top-level-${key.replace(/_/g, '-')}-drift`,
    severity: 'warning',
    message: `Top-level ${key} is "${actual}" instead of "${expected}".`,
  });
}

function topLevelValue(content: string, key: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      return undefined;
    }
    const match = line.match(keyPattern);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
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

function validateGeneratedToml(content: string): void {
  try {
    Bun.TOML.parse(content);
  } catch (cause) {
    throw new Error('Generated Codex config must be valid TOML', { cause });
  }
}

function isValidToml(content: string): boolean {
  try {
    Bun.TOML.parse(content);
    return true;
  } catch {
    return false;
  }
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

function validateReasoningEffort(value: string): ICodexReasoningEffort {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value;
  }
  throw new Error('Volare Codex reasoning effort must be one of: low, medium, high, xhigh');
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

function backupPathFor(configPath: string, options: ICodexConfigOptions): string {
  return join(
    dirname(configPath),
    'backups',
    'volare',
    `config-${options.backupSuffix ?? backupSuffix()}.toml`,
  );
}

async function pruneBackups(backupDir: string, keep: number): Promise<void> {
  if (keep < 1) {
    return;
  }
  const entries = await readdir(backupDir, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isFile() && /^config-.+\.toml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const stale = backups.slice(0, Math.max(0, backups.length - keep));
  await Promise.all(stale.map((name) => rm(join(backupDir, name), { force: true })));
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
