import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCodexConfig,
  buildCodexProfileConfig,
  configureCodex,
  detectCodexProfileModeFromVersion,
  inspectCodexConfigText,
} from '../../../scripts/config-codex';

describe('config-codex script', () => {
  test('detects Codex profile-file mode from current CLI versions', () => {
    expect(detectCodexProfileModeFromVersion('codex-cli 0.136.0')).toBe('profile-file');
    expect(detectCodexProfileModeFromVersion('codex 0.134.0')).toBe('profile-file');
    expect(detectCodexProfileModeFromVersion('codex 0.133.0')).toBe('legacy-single-file');
    expect(detectCodexProfileModeFromVersion('custom codex build')).toBe('profile-file');
  });

  test('builds modern Codex base config while preserving unrelated sections', () => {
    const config = buildCodexConfig(
      [
        'model = "old-model"',
        '',
        '[model_providers.other]',
        'name = "Other"',
        'base_url = "https://example.test/v1"',
        '',
        '[profiles.other]',
        'model_provider = "other"',
        'model = "other-model"',
      ].join('\n'),
    );

    expect(config).not.toContain('profile = "volare"');
    expect(config).toContain('model_provider = "volare"');
    expect(config).toContain('model = "gpt-5.5"');
    expect(config).toContain('model_reasoning_effort = "high"');
    expect(config).toContain('[model_providers.other]');
    expect(config).toContain('[profiles.other]');
    expect(config).not.toContain('[model_providers.volare]');
    expect(config).not.toContain('[profiles.volare]');
    expect(config).not.toContain('# >>> volare managed');
    expect(Bun.TOML.parse(config)).toBeTruthy();
  });

  test('builds modern Codex Volare profile config', () => {
    const config = buildCodexProfileConfig(
      [
        'profile = "volare"',
        'model_provider = "old"',
        '',
        '[profiles.volare]',
        'model_provider = "old"',
      ].join('\n'),
      {
        baseUrl: 'http://127.0.0.1:8765/openai/v1',
        envKey: 'CUSTOM_VOLARE_API_KEY',
        reasoningEffort: 'xhigh',
        requiresOpenAIAuth: false,
      },
    );

    expect(config).not.toContain('profile = "volare"');
    expect(config).toContain('model_provider = "volare"');
    expect(config).toContain('model = "gpt-5.5"');
    expect(config).toContain('model_reasoning_effort = "xhigh"');
    expect(config).toContain('[model_providers.volare]');
    expect(config).not.toContain('[profiles.volare]');
    expect(config).toContain('base_url = "http://127.0.0.1:8765/openai/v1"');
    expect(config).toContain('env_key = "CUSTOM_VOLARE_API_KEY"');
    expect(config).toContain('requires_openai_auth = false');
    expect(Bun.TOML.parse(config)).toBeTruthy();
  });

  test('preserves legacy single-file config as an explicit fallback', () => {
    const config = buildCodexConfig('', { profileMode: 'legacy-single-file' });

    expect(config).toContain('profile = "volare"');
    expect(config).toContain('[model_providers.volare]');
    expect(config).toContain('[profiles.volare]');
    expect(config).toContain('# >>> volare managed');
    expect(config).toContain('# <<< volare managed');
  });

  test('migrates legacy Volare sections out of the modern base config', () => {
    const config = buildCodexConfig(
      [
        'profile = "volare"',
        'model_provider = "old"',
        'model = "old"',
        'model_reasoning_effort = "medium"',
        '',
        '[model_providers.volare]',
        'name = "Old Volare"',
        'base_url = "http://127.0.0.1:1/openai/v1"',
        'requires_openai_auth = false',
        '',
        '[profiles.volare]',
        'model_provider = "old"',
        'model = "old"',
        'model_reasoning_effort = "medium"',
      ].join('\n'),
      {
        baseUrl: 'http://127.0.0.1:8765/openai/v1',
        envKey: 'CUSTOM_VOLARE_API_KEY',
      },
    );

    expect(config).not.toContain('profile = "volare"');
    expect(config).not.toContain('[model_providers.volare]');
    expect(config).not.toContain('[profiles.volare]');
    expect(config).not.toContain('Old Volare');
    expect(config).not.toContain('requires_openai_auth = false');
    expect(config).not.toContain('model_reasoning_effort = "medium"');
    expect(config.match(/model_reasoning_effort = "high"/g)).toHaveLength(1);
  });

  test('replaces modern base and profile config idempotently', () => {
    const firstBase = buildCodexConfig('', {
      baseUrl: 'http://127.0.0.1:8765/openai/v1',
      reasoningEffort: 'xhigh',
    });
    const secondBase = buildCodexConfig(firstBase, {
      baseUrl: 'http://127.0.0.1:8765/openai/v1',
      reasoningEffort: 'xhigh',
    });
    const firstProfile = buildCodexProfileConfig('', {
      baseUrl: 'http://127.0.0.1:8765/openai/v1',
      reasoningEffort: 'xhigh',
    });
    const secondProfile = buildCodexProfileConfig(firstProfile, {
      baseUrl: 'http://127.0.0.1:8765/openai/v1',
      reasoningEffort: 'xhigh',
    });

    expect(secondBase).toBe(firstBase);
    expect(secondBase.match(/\[model_providers\.volare\]/g)).toBeNull();
    expect(secondBase.match(/\[profiles\.volare\]/g)).toBeNull();
    expect(secondBase.match(/model_reasoning_effort = "xhigh"/g)).toHaveLength(1);
    expect(secondProfile).toBe(firstProfile);
    expect(secondProfile.match(/\[model_providers\.volare\]/g)).toHaveLength(1);
    expect(secondProfile.match(/model_reasoning_effort = "xhigh"/g)).toHaveLength(1);
  });

  test('replaces the legacy managed block idempotently in legacy mode', () => {
    const first = buildCodexConfig('', {
      profileMode: 'legacy-single-file',
      baseUrl: 'http://127.0.0.1:8765/openai/v1',
      reasoningEffort: 'xhigh',
    });
    const second = buildCodexConfig(first, {
      profileMode: 'legacy-single-file',
      baseUrl: 'http://127.0.0.1:8765/openai/v1',
      reasoningEffort: 'xhigh',
    });

    expect(second).toBe(first);
    expect(second.match(/# >>> volare managed/g)).toHaveLength(1);
    expect(second.match(/# <<< volare managed/g)).toHaveLength(1);
    expect(second.match(/\[model_providers\.volare\]/g)).toHaveLength(1);
    expect(second.match(/\[profiles\.volare\]/g)).toHaveLength(1);
    expect(second.match(/model_reasoning_effort = "xhigh"/g)).toHaveLength(2);
  });

  test('removes known Volare-owned Agent Loom legacy sections', () => {
    const config = buildCodexConfig(
      [
        '[model_providers.agent-loom]',
        'name = "Agent Loom"',
        'base_url = "http://127.0.0.1:8000/openai/v1"',
        'env_key = "VOLARE_API_KEY"',
        '',
        '[profiles.agent-loom]',
        'model_provider = "agent-loom"',
        'model = "copilot-agent"',
        '',
        '[model_providers.other]',
        'name = "Other"',
      ].join('\n'),
    );

    expect(config).not.toContain('[model_providers.agent-loom]');
    expect(config).not.toContain('[profiles.agent-loom]');
    expect(config).toContain('[model_providers.other]');
    expect(config).not.toContain('[model_providers.volare]');
  });

  test('reports modern doctor issues without config values that could contain secrets', () => {
    const inspection = inspectCodexConfigText(
      [
        'profile = "volare"',
        'model = "gpt-5.4"',
        'model_reasoning_effort = "medium"',
        '',
        '[model_providers.volare]',
        'env_key = "SENSITIVE_VOLARE_TOKEN_NAME"',
      ].join('\n'),
    );

    expect(inspection.healthy).toBe(false);
    expect(inspection.profileMode).toBe('profile-file');
    expect(inspection.issues.map((issue) => issue.code)).toContain('missing-profile-config');
    expect(inspection.issues.map((issue) => issue.code)).toContain('legacy-base-profile-selector');
    expect(inspection.issues.map((issue) => issue.code)).toContain('legacy-base-volare-provider');
    expect(inspection.issues.map((issue) => issue.code)).toContain('top-level-model-drift');
    expect(JSON.stringify(inspection)).not.toContain('SENSITIVE_VOLARE_TOKEN_NAME');
  });

  test('reports healthy modern config across base and profile files', () => {
    const base = buildCodexConfig('');
    const profile = buildCodexProfileConfig('');
    const inspection = inspectCodexConfigText(base, { profileConfigText: profile });

    expect(inspection).toEqual({
      profileMode: 'profile-file',
      healthy: true,
      issues: [],
    });
  });

  test('diagnoses unclosed managed blocks without trying to repair over user config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-codex-config-'));
    const configPath = join(root, 'config.toml');
    const existing = [
      'profile = "volare"',
      '',
      '# >>> volare managed',
      '[model_providers.volare]',
      'name = "Volare"',
      '',
      '[model_providers.other]',
      'name = "Other"',
    ].join('\n');
    await writeFile(configPath, existing);

    try {
      const inspection = inspectCodexConfigText(existing);

      expect(inspection.profileMode).toBe('profile-file');
      expect(inspection.healthy).toBe(false);
      expect(inspection.issues).toContainEqual({
        code: 'managed-block-unclosed',
        severity: 'error',
        message: 'Volare managed block start marker is missing its end marker.',
      });
      await expect(configureCodex({ configPath })).rejects.toThrow(
        'Volare managed Codex config block is missing its end marker',
      );
      await expect(readFile(configPath, 'utf8')).resolves.toBe(existing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('doctor reports invalid TOML that Volare repair cannot fix', () => {
    const inspection = inspectCodexConfigText(
      [
        '[model_providers.other]',
        'name = "Other"',
        '',
        '[model_providers.other]',
        'name = "Duplicate"',
      ].join('\n'),
    );

    expect(inspection.healthy).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toContain('codex-config-invalid-toml');
    expect(JSON.stringify(inspection)).not.toContain('Duplicate');
  });

  test('rejects invalid Codex provider settings', () => {
    expect(() => buildCodexProfileConfig('', { baseUrl: 'not a url' })).toThrow(
      'Volare Codex base URL must be a valid URL',
    );
    expect(() => buildCodexProfileConfig('', { baseUrl: 'ftp://example.test/openai/v1' })).toThrow(
      'Volare Codex base URL must use http or https',
    );
    expect(() => buildCodexProfileConfig('', { envKey: 'BAD-KEY' })).toThrow(
      'Volare Codex env key must be a valid environment variable name',
    );
  });

  test('writes modern base and profile config with backups only when changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-codex-config-'));
    const configPath = join(root, 'config.toml');
    const profileConfigPath = join(root, 'volare.config.toml');
    await writeFile(configPath, 'model = "old"\n');

    try {
      const first = await configureCodex({
        configPath,
        backupSuffix: 'test',
        requiresOpenAIAuth: false,
      });
      const second = await configureCodex({
        configPath,
        backupSuffix: 'test-again',
        requiresOpenAIAuth: false,
      });

      expect(first).toMatchObject({
        configPath,
        profileMode: 'profile-file',
        changed: true,
        profileConfigPath,
        backupPath: join(root, 'backups', 'volare', 'config-test.toml'),
      });
      expect(second).toEqual({
        configPath,
        profileMode: 'profile-file',
        changed: false,
        profileConfigPath,
      });
      await expect(
        readFile(join(root, 'backups', 'volare', 'config-test.toml'), 'utf8'),
      ).resolves.toBe('model = "old"\n');
      await expect(readFile(configPath, 'utf8')).resolves.not.toContain('[profiles.volare]');
      await expect(readFile(profileConfigPath, 'utf8')).resolves.toContain(
        '[model_providers.volare]',
      );
      await expect(readFile(profileConfigPath, 'utf8')).resolves.toContain(
        'requires_openai_auth = false',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('backs up an existing profile config independently from base backups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-codex-config-'));
    const configPath = join(root, 'config.toml');
    const profileConfigPath = join(root, 'volare.config.toml');

    try {
      await configureCodex({ configPath });
      const oldProfile = 'model_provider = "old"\n';
      await writeFile(profileConfigPath, oldProfile);
      const result = await configureCodex({ configPath, backupSuffix: 'profile' });

      expect(result).toMatchObject({
        configPath,
        profileMode: 'profile-file',
        changed: true,
        profileConfigPath,
        profileBackupPath: join(root, 'backups', 'volare', 'volare.config-profile.toml'),
      });
      expect(result.backupPath).toBeUndefined();
      await expect(
        readFile(join(root, 'backups', 'volare', 'volare.config-profile.toml'), 'utf8'),
      ).resolves.toBe(oldProfile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('writes legacy config and backs up an existing file only when changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-codex-config-'));
    const configPath = join(root, 'config.toml');
    await writeFile(configPath, 'profile = "other"\n');

    try {
      const first = await configureCodex({
        configPath,
        profileMode: 'legacy-single-file',
        backupSuffix: 'test',
      });
      const second = await configureCodex({
        configPath,
        profileMode: 'legacy-single-file',
        backupSuffix: 'test-again',
      });

      expect(first).toMatchObject({
        configPath,
        profileMode: 'legacy-single-file',
        changed: true,
        backupPath: join(root, 'backups', 'volare', 'config-test.toml'),
      });
      expect(second).toEqual({
        configPath,
        profileMode: 'legacy-single-file',
        changed: false,
      });
      await expect(
        readFile(join(root, 'backups', 'volare', 'config-test.toml'), 'utf8'),
      ).resolves.toBe('profile = "other"\n');
      await expect(readFile(configPath, 'utf8')).resolves.toContain('[model_providers.volare]');
      await expect(readFile(configPath, 'utf8')).resolves.toContain('[profiles.volare]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('prunes old Volare backup files by backup prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-codex-config-'));
    const configPath = join(root, 'config.toml');
    const profileConfigPath = join(root, 'volare.config.toml');
    await writeFile(configPath, 'model = "first"\n');

    try {
      await configureCodex({ configPath, backupSuffix: '001', backupLimit: 2 });
      await writeFile(configPath, 'model = "second"\n');
      await writeFile(profileConfigPath, 'model_provider = "second"\n');
      await configureCodex({ configPath, backupSuffix: '002', backupLimit: 2 });
      await writeFile(configPath, 'model = "third"\n');
      await writeFile(profileConfigPath, 'model_provider = "third"\n');
      await configureCodex({ configPath, backupSuffix: '003', backupLimit: 2 });

      const backupDir = join(root, 'backups', 'volare');
      await expect(readFile(join(backupDir, 'config-001.toml'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(backupDir, 'config-002.toml'), 'utf8')).resolves.toBe(
        'model = "second"\n',
      );
      await expect(readFile(join(backupDir, 'config-003.toml'), 'utf8')).resolves.toBe(
        'model = "third"\n',
      );
      await expect(readFile(join(backupDir, 'volare.config-001.toml'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(backupDir, 'volare.config-002.toml'), 'utf8')).resolves.toBe(
        'model_provider = "second"\n',
      );
      await expect(readFile(join(backupDir, 'volare.config-003.toml'), 'utf8')).resolves.toBe(
        'model_provider = "third"\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
