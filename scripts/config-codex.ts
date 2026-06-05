import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const DEFAULT_PROFILE = 'volare';
const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/openai/v1';
const DEFAULT_ENV_KEY = 'VOLARE_API_KEY';
const MANAGED_BLOCK_START = '# >>> volare managed';
const MANAGED_BLOCK_END = '# <<< volare managed';
const DEFAULT_BACKUP_LIMIT = 10;
const PROFILE_FILE_MIN_VERSION = {
  major: 0,
  minor: 134,
  patch: 0,
};

export type ICodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexProfileMode = 'profile-file' | 'legacy-single-file';
export type ICodexConfigIssueSeverity = 'warning' | 'error';

export interface ICodexConfigIssue {
  code: string;
  severity: ICodexConfigIssueSeverity;
  message: string;
}

export interface ICodexConfigOptions {
  configPath?: string;
  profileConfigPath?: string;
  codexCommand?: string;
  baseUrl?: string;
  envKey?: string;
  reasoningEffort?: ICodexReasoningEffort;
  requiresOpenAIAuth?: boolean;
  profileMode?: CodexProfileMode;
  backupSuffix?: string;
  backupLimit?: number;
}

export interface ICodexConfigResult {
  configPath: string;
  profileMode: CodexProfileMode;
  changed: boolean;
  backupPath?: string;
  profileConfigPath?: string;
  profileBackupPath?: string;
}

export interface ICodexConfigInspection {
  configPath: string;
  profileMode: CodexProfileMode;
  healthy: boolean;
  issues: ICodexConfigIssue[];
  profileConfigPath?: string;
}

export function detectCodexProfileModeFromVersion(versionText: string): CodexProfileMode {
  const version = firstSemanticVersion(versionText);
  if (!version) {
    return 'profile-file';
  }
  return compareSemanticVersion(version, PROFILE_FILE_MIN_VERSION) >= 0
    ? 'profile-file'
    : 'legacy-single-file';
}

export async function detectInstalledCodexProfileMode(
  codexCommand = 'codex',
): Promise<CodexProfileMode> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([codexCommand, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return 'profile-file';
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readPipeText(proc.stdout),
    readPipeText(proc.stderr),
  ]);
  if (exitCode !== 0) {
    return 'profile-file';
  }
  return detectCodexProfileModeFromVersion(`${stdout}\n${stderr}`);
}

async function resolveProfileMode(options: {
  profileMode?: CodexProfileMode;
  codexCommand?: string;
}): Promise<CodexProfileMode> {
  return options.profileMode ?? (await detectInstalledCodexProfileMode(options.codexCommand));
}

export async function configureCodex(
  options: ICodexConfigOptions = {},
): Promise<ICodexConfigResult> {
  const configPath = options.configPath ?? defaultConfigPath();
  const profileMode = await resolveProfileMode(options);
  const existing = await readTextIfExists(configPath);
  const resolvedOptions = resolveConfigOptions(options);

  if (profileMode === 'legacy-single-file') {
    const next = buildCodexConfig(existing, {
      ...resolvedOptions,
      profileMode,
    });
    validateGeneratedToml(next, 'Generated Codex config must be valid TOML');

    if (existing === next) {
      return { configPath, profileMode, changed: false };
    }

    await mkdir(dirname(configPath), { recursive: true });
    const backupPath =
      existing.length > 0 ? backupPathFor(configPath, options, 'config') : undefined;
    if (backupPath) {
      await mkdir(dirname(backupPath), { recursive: true });
      await Bun.write(backupPath, existing);
    }
    await Bun.write(configPath, next);
    if (backupPath) {
      await pruneBackups(
        dirname(backupPath),
        options.backupLimit ?? DEFAULT_BACKUP_LIMIT,
        'config',
      );
    }
    return {
      configPath,
      profileMode,
      changed: true,
      ...(backupPath ? { backupPath } : {}),
    };
  }

  const profileConfigPath = options.profileConfigPath ?? defaultProfileConfigPath(configPath);
  const existingProfile = await readTextIfExists(profileConfigPath);
  const nextBase = buildCodexConfig(existing, {
    ...resolvedOptions,
    profileMode,
  });
  const nextProfile = buildCodexProfileConfig(existingProfile, resolvedOptions);
  validateGeneratedToml(nextBase, 'Generated Codex base config must be valid TOML');
  validateGeneratedToml(nextProfile, 'Generated Codex profile config must be valid TOML');

  const baseChanged = existing !== nextBase;
  const profileChanged = existingProfile !== nextProfile;
  if (!baseChanged && !profileChanged) {
    return { configPath, profileMode, changed: false, profileConfigPath };
  }

  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(dirname(profileConfigPath), { recursive: true });
  const backupPath =
    baseChanged && existing.length > 0 ? backupPathFor(configPath, options, 'config') : undefined;
  const profileBackupPath =
    profileChanged && existingProfile.length > 0
      ? backupPathFor(profileConfigPath, options, backupPrefixFor(profileConfigPath))
      : undefined;
  if (backupPath) {
    await mkdir(dirname(backupPath), { recursive: true });
    await Bun.write(backupPath, existing);
  }
  if (profileBackupPath) {
    await mkdir(dirname(profileBackupPath), { recursive: true });
    await Bun.write(profileBackupPath, existingProfile);
  }
  if (profileChanged) {
    await Bun.write(profileConfigPath, nextProfile);
  }
  if (baseChanged) {
    await Bun.write(configPath, nextBase);
  }
  if (backupPath) {
    await pruneBackups(dirname(backupPath), options.backupLimit ?? DEFAULT_BACKUP_LIMIT, 'config');
  }
  if (profileBackupPath) {
    await pruneBackups(
      dirname(profileBackupPath),
      options.backupLimit ?? DEFAULT_BACKUP_LIMIT,
      backupPrefixFor(profileConfigPath),
    );
  }
  return {
    configPath,
    profileMode,
    changed: true,
    profileConfigPath,
    ...(backupPath ? { backupPath } : {}),
    ...(profileBackupPath ? { profileBackupPath } : {}),
  };
}

interface IResolvedCodexConfigOptions {
  baseUrl: string;
  envKey: string;
  reasoningEffort: ICodexReasoningEffort;
  requiresOpenAIAuth: boolean;
}

function resolveConfigOptions(options: {
  baseUrl?: string;
  envKey?: string;
  reasoningEffort?: ICodexReasoningEffort;
  requiresOpenAIAuth?: boolean;
}): IResolvedCodexConfigOptions {
  return {
    baseUrl: validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    envKey: validateEnvKey(options.envKey ?? DEFAULT_ENV_KEY),
    reasoningEffort: validateReasoningEffort(options.reasoningEffort ?? DEFAULT_REASONING_EFFORT),
    requiresOpenAIAuth: options.requiresOpenAIAuth ?? true,
  };
}

export function buildCodexProfileConfig(
  existing: string,
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
    requiresOpenAIAuth?: boolean;
  } = {},
): string {
  const resolvedOptions = resolveConfigOptions(options);
  const withoutVolareSections = removeSection(
    removeSection(existing, `[model_providers.${DEFAULT_PROFILE}]`),
    `[profiles.${DEFAULT_PROFILE}]`,
  );
  const withoutLegacyProfileSelector = removeTopLevelKeyIfValue(
    withoutVolareSections,
    'profile',
    DEFAULT_PROFILE,
  );
  const withDefaults = setTopLevelKeys(withoutLegacyProfileSelector, [
    ['model_provider', DEFAULT_PROFILE],
    ['model', DEFAULT_MODEL],
    ['model_reasoning_effort', resolvedOptions.reasoningEffort],
  ]);
  return `${trimTrailingWhitespace(withDefaults)}

${profileProviderBlock(resolvedOptions)}`;
}

function buildModernBaseConfig(
  existing: string,
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
    requiresOpenAIAuth?: boolean;
  } = {},
): string {
  const resolvedOptions = resolveConfigOptions(options);
  const managedBlockResult = removeManagedBlock(existing);
  if (managedBlockResult.unbalancedStart) {
    throw new Error(
      'Volare managed Codex config block is missing its end marker; run "volare config codex doctor" and fix the config before repair.',
    );
  }
  const withoutManagedSections = removeLegacyVolareSections(
    removeSection(
      removeSection(managedBlockResult.content, `[model_providers.${DEFAULT_PROFILE}]`),
      `[profiles.${DEFAULT_PROFILE}]`,
    ),
  );
  const withoutLegacyProfileSelector = removeTopLevelKeyIfValue(
    withoutManagedSections,
    'profile',
    DEFAULT_PROFILE,
  );
  const withDefaults = setTopLevelKeys(withoutLegacyProfileSelector, [
    ['model_provider', DEFAULT_PROFILE],
    ['model', DEFAULT_MODEL],
    ['model_reasoning_effort', resolvedOptions.reasoningEffort],
  ]);
  return `${trimTrailingWhitespace(withDefaults)}

${profileProviderBlock(resolvedOptions)}`;
}

function buildLegacySingleFileConfig(
  existing: string,
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
    requiresOpenAIAuth?: boolean;
  } = {},
): string {
  const resolvedOptions = resolveConfigOptions(options);
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
    ['model_reasoning_effort', resolvedOptions.reasoningEffort],
  ]);
  return `${trimTrailingWhitespace(withDefaults)}

${legacyManagedBlock(resolvedOptions)}`;
}

export function buildCodexConfig(
  existing: string,
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
    requiresOpenAIAuth?: boolean;
    profileMode?: CodexProfileMode;
  } = {},
): string {
  if ((options.profileMode ?? 'profile-file') === 'legacy-single-file') {
    return buildLegacySingleFileConfig(existing, options);
  }
  return buildModernBaseConfig(existing, options);
}

export async function inspectCodexConfig(
  options: ICodexConfigOptions = {},
): Promise<ICodexConfigInspection> {
  const configPath = options.configPath ?? defaultConfigPath();
  const profileMode = await resolveProfileMode(options);
  const existing = await readTextIfExists(configPath);
  if (profileMode === 'legacy-single-file') {
    return {
      configPath,
      ...inspectCodexConfigText(existing, options),
    };
  }
  const profileConfigPath = options.profileConfigPath ?? defaultProfileConfigPath(configPath);
  const profileConfigText = await readTextIfExists(profileConfigPath);
  return {
    configPath,
    profileConfigPath,
    ...inspectCodexConfigText(existing, {
      ...options,
      profileMode,
      profileConfigText,
    }),
  };
}

export function inspectCodexConfigText(
  existing: string,
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
    requiresOpenAIAuth?: boolean;
    profileMode?: CodexProfileMode;
    profileConfigText?: string;
  } = {},
): Omit<ICodexConfigInspection, 'configPath'> {
  if ((options.profileMode ?? 'profile-file') === 'legacy-single-file') {
    return inspectLegacyCodexConfigText(existing, options);
  }
  return inspectProfileFileCodexConfigText(existing, options);
}

function inspectProfileFileCodexConfigText(
  existing: string,
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
    requiresOpenAIAuth?: boolean;
    profileConfigText?: string;
  } = {},
): Omit<ICodexConfigInspection, 'configPath'> {
  const issues: ICodexConfigIssue[] = [];
  const managedBlockResult = removeManagedBlock(existing);
  const outsideManagedBlock = managedBlockResult.content;
  const profileConfigText = options.profileConfigText ?? '';

  if (existing.trim().length === 0) {
    issues.push({
      code: 'missing-base-config',
      severity: 'warning',
      message: 'Codex base config does not exist yet; run "volare config codex" to create it.',
    });
  }

  if (profileConfigText.trim().length === 0) {
    issues.push({
      code: 'missing-profile-config',
      severity: 'warning',
      message: 'Codex Volare profile config does not exist yet.',
    });
  }

  if (managedBlockResult.unbalancedStart) {
    issues.push({
      code: 'managed-block-unclosed',
      severity: 'error',
      message: 'Volare managed block start marker is missing its end marker.',
    });
    return {
      profileMode: 'profile-file',
      healthy: false,
      issues,
    };
  }

  const desiredBase = buildCodexConfig(existing, { ...options, profileMode: 'profile-file' });
  const desiredProfile = buildCodexProfileConfig(profileConfigText, options);
  if (!isValidToml(desiredBase)) {
    issues.push({
      code: 'codex-config-invalid-toml',
      severity: 'error',
      message:
        'Codex base config would remain invalid after Volare repair; fix non-Volare TOML syntax or duplicate sections.',
    });
  }
  if (!isValidToml(desiredProfile)) {
    issues.push({
      code: 'codex-profile-config-invalid-toml',
      severity: 'error',
      message:
        'Codex Volare profile config would remain invalid after Volare repair; fix non-Volare TOML syntax or duplicate sections.',
    });
  }

  if (managedBlockResult.removed) {
    issues.push({
      code: 'legacy-managed-block',
      severity: 'warning',
      message: 'Found a legacy Volare managed block in the Codex base config.',
    });
  }

  if (topLevelValue(existing, 'profile') === DEFAULT_PROFILE) {
    issues.push({
      code: 'legacy-base-profile-selector',
      severity: 'warning',
      message: 'Found legacy top-level profile selector in the Codex base config.',
    });
  }

  if (hasSection(outsideManagedBlock, `[profiles.${DEFAULT_PROFILE}]`)) {
    issues.push({
      code: 'legacy-base-profile-table',
      severity: 'warning',
      message: 'Found a legacy Volare profile table in the Codex base config.',
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
  addTopLevelDriftIssue(issues, existing, 'model_provider', DEFAULT_PROFILE);
  addTopLevelDriftIssue(issues, existing, 'model', DEFAULT_MODEL);
  addTopLevelDriftIssue(issues, existing, 'model_reasoning_effort', expectedReasoningEffort);

  if (existing !== desiredBase && issues.length === 0) {
    issues.push({
      code: 'base-config-drift',
      severity: 'warning',
      message: 'Volare-owned Codex base config differs from the current desired config.',
    });
  }

  if (profileConfigText !== desiredProfile && issues.length === 0) {
    issues.push({
      code: 'profile-config-drift',
      severity: 'warning',
      message: 'Volare-owned Codex profile config differs from the current desired config.',
    });
  }

  return {
    profileMode: 'profile-file',
    healthy: issues.length === 0,
    issues,
  };
}

function inspectLegacyCodexConfigText(
  existing: string,
  options: {
    baseUrl?: string;
    envKey?: string;
    reasoningEffort?: ICodexReasoningEffort;
    requiresOpenAIAuth?: boolean;
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
      profileMode: 'legacy-single-file',
      healthy: false,
      issues,
    };
  }

  const desired = buildCodexConfig(existing, { ...options, profileMode: 'legacy-single-file' });
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
    profileMode: 'legacy-single-file',
    healthy: issues.length === 0,
    issues,
  };
}

function profileProviderBlock(options: IResolvedCodexConfigOptions): string {
  return `[model_providers.${DEFAULT_PROFILE}]
name = "Volare"
base_url = "${escapeTomlString(options.baseUrl)}"
wire_api = "responses"
env_key = "${escapeTomlString(options.envKey)}"
requires_openai_auth = ${options.requiresOpenAIAuth}
supports_websockets = false
`;
}

function legacyManagedBlock(options: IResolvedCodexConfigOptions): string {
  return `${MANAGED_BLOCK_START}
[model_providers.${DEFAULT_PROFILE}]
name = "Volare"
base_url = "${escapeTomlString(options.baseUrl)}"
wire_api = "responses"
env_key = "${escapeTomlString(options.envKey)}"
requires_openai_auth = ${options.requiresOpenAIAuth}
supports_websockets = false

[profiles.${DEFAULT_PROFILE}]
model_provider = "${DEFAULT_PROFILE}"
model = "${DEFAULT_MODEL}"
model_reasoning_effort = "${escapeTomlString(options.reasoningEffort)}"
${MANAGED_BLOCK_END}
`;
}

function removeTopLevelKeyIfValue(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"${escapeRegExp(value)}"\\s*$`);
  let inTopLevel = true;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inTopLevel = false;
    }
    if (inTopLevel && keyPattern.test(line)) {
      continue;
    }
    output.push(line);
  }
  return output.join('\n');
}

function setTopLevelKeys(content: string, entries: Array<[string, string]>): string {
  const lines = content.split(/\r?\n/);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const boundary = firstSectionIndex >= 0 ? firstSectionIndex : lines.length;
  const topLevel = lines.slice(0, boundary).filter((line, index, all) => {
    return line.trim().length > 0 || index !== all.length - 1;
  });
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

function validateGeneratedToml(content: string, message: string): void {
  try {
    Bun.TOML.parse(content);
  } catch (cause) {
    throw new Error(message, { cause });
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

function firstSemanticVersion(
  text: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  const [, major, minor, patch] = match ?? [];
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
}

function compareSemanticVersion(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readTextIfExists(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : '';
}

async function readPipeText(
  pipe: ReadableStream<Uint8Array> | number | undefined,
): Promise<string> {
  return pipe instanceof ReadableStream ? await new Response(pipe).text() : '';
}

function defaultConfigPath(): string {
  return join(defaultCodexHome(), 'config.toml');
}

function defaultProfileConfigPath(configPath: string): string {
  return join(dirname(configPath), `${DEFAULT_PROFILE}.config.toml`);
}

function defaultCodexHome(): string {
  const codexHome = Bun.env['CODEX_HOME'];
  if (codexHome) {
    return codexHome;
  }
  const home = Bun.env['HOME'];
  if (!home) {
    throw new Error('HOME or CODEX_HOME must be set to locate Codex config');
  }
  return join(home, '.codex');
}

function backupSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupPathFor(configPath: string, options: ICodexConfigOptions, prefix: string): string {
  return join(
    dirname(configPath),
    'backups',
    'volare',
    `${prefix}-${options.backupSuffix ?? backupSuffix()}.toml`,
  );
}

function backupPrefixFor(path: string): string {
  return basename(path).replace(/\.toml$/, '');
}

async function pruneBackups(backupDir: string, keep: number, prefix: string): Promise<void> {
  if (keep < 1) {
    return;
  }
  const backupPattern = new RegExp(`^${escapeRegExp(prefix)}-.+\\.toml$`);
  const entries = await readdir(backupDir, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isFile() && backupPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const stale = backups.slice(0, Math.max(0, backups.length - keep));
  await Promise.all(stale.map((name) => rm(join(backupDir, name), { force: true })));
}

if (import.meta.main) {
  const result = await configureCodex();
  if (result.changed) {
    console.log(`Configured Codex for Volare: ${result.configPath}`);
    console.log(`Codex profile mode: ${result.profileMode}`);
    if (result.profileConfigPath) {
      console.log(`Codex profile config: ${result.profileConfigPath}`);
    }
    if (result.backupPath) {
      console.log(`Backup written: ${result.backupPath}`);
    }
    if (result.profileBackupPath) {
      console.log(`Profile backup written: ${result.profileBackupPath}`);
    }
  } else {
    console.log(`Codex is already configured for Volare: ${result.configPath}`);
    console.log(`Codex profile mode: ${result.profileMode}`);
    if (result.profileConfigPath) {
      console.log(`Codex profile config: ${result.profileConfigPath}`);
    }
  }
}
