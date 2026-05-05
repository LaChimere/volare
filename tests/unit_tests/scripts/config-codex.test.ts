import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCodexConfig,
  configureCodex,
  inspectCodexConfigText,
} from '../../../scripts/config-codex';

describe('config-codex script', () => {
  test('builds Codex Volare config while preserving unrelated sections', () => {
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

    expect(config).toContain('profile = "volare"');
    expect(config).toContain('model_provider = "volare"');
    expect(config).toContain('model = "gpt-5.5"');
    expect(config).toContain('model_reasoning_effort = "high"');
    expect(config).toContain('[model_providers.other]');
    expect(config).toContain('[profiles.other]');
    expect(config).toContain('[model_providers.volare]');
    expect(config).toContain('base_url = "http://127.0.0.1:8000/openai/v1"');
    expect(config).toContain('env_key = "VOLARE_API_KEY"');
    expect(config).toContain('requires_openai_auth = true');
    expect(config).toContain('[profiles.volare]');
    expect(config).toContain('# >>> volare managed');
    expect(config).toContain('# <<< volare managed');
  });

  test('replaces existing Volare sections instead of duplicating them', () => {
    const config = buildCodexConfig(
      [
        'profile = "old"',
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

    expect(config.match(/\[model_providers\.volare\]/g)).toHaveLength(1);
    expect(config.match(/\[profiles\.volare\]/g)).toHaveLength(1);
    expect(config).not.toContain('Old Volare');
    expect(config).toContain('base_url = "http://127.0.0.1:8765/openai/v1"');
    expect(config).toContain('env_key = "CUSTOM_VOLARE_API_KEY"');
    expect(config).toContain('requires_openai_auth = true');
    expect(config).not.toContain('requires_openai_auth = false');
    expect(config).not.toContain('model_reasoning_effort = "medium"');
    expect(config.match(/model_reasoning_effort = "high"/g)).toHaveLength(2);
  });

  test('replaces the managed block idempotently', () => {
    const first = buildCodexConfig('', {
      baseUrl: 'http://127.0.0.1:8765/openai/v1',
      reasoningEffort: 'xhigh',
    });
    const second = buildCodexConfig(first, {
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
    expect(config).toContain('[model_providers.volare]');
  });

  test('reports safe doctor issues without config values that could contain secrets', () => {
    const inspection = inspectCodexConfigText(
      [
        'profile = "other"',
        'model = "gpt-5.4"',
        'model_reasoning_effort = "medium"',
        '',
        '[model_providers.volare]',
        'env_key = "SENSITIVE_VOLARE_TOKEN_NAME"',
      ].join('\n'),
    );

    expect(inspection.healthy).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toContain('managed-block-missing');
    expect(inspection.issues.map((issue) => issue.code)).toContain('unmanaged-volare-provider');
    expect(inspection.issues.map((issue) => issue.code)).toContain('top-level-model-drift');
    expect(JSON.stringify(inspection)).not.toContain('SENSITIVE_VOLARE_TOKEN_NAME');
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

      expect(inspection).toMatchObject({
        healthy: false,
        issues: [{ code: 'managed-block-unclosed', severity: 'error' }],
      });
      await expect(configureCodex({ configPath })).rejects.toThrow(
        'Volare managed Codex config block is missing its end marker',
      );
      await expect(readFile(configPath, 'utf8')).resolves.toBe(existing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects invalid Codex provider settings', () => {
    expect(() => buildCodexConfig('', { baseUrl: 'not a url' })).toThrow(
      'Volare Codex base URL must be a valid URL',
    );
    expect(() => buildCodexConfig('', { baseUrl: 'ftp://example.test/openai/v1' })).toThrow(
      'Volare Codex base URL must use http or https',
    );
    expect(() => buildCodexConfig('', { envKey: 'BAD-KEY' })).toThrow(
      'Volare Codex env key must be a valid environment variable name',
    );
  });

  test('writes config and backs up an existing file only when changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-codex-config-'));
    const configPath = join(root, 'config.toml');
    await writeFile(configPath, 'profile = "other"\n');

    try {
      const first = await configureCodex({
        configPath,
        backupSuffix: 'test',
      });
      const second = await configureCodex({
        configPath,
        backupSuffix: 'test-again',
      });

      expect(first).toMatchObject({
        configPath,
        changed: true,
        backupPath: join(root, 'backups', 'volare', 'config-test.toml'),
      });
      expect(second).toEqual({
        configPath,
        changed: false,
      });
      await expect(
        readFile(join(root, 'backups', 'volare', 'config-test.toml'), 'utf8'),
      ).resolves.toBe('profile = "other"\n');
      await expect(readFile(configPath, 'utf8')).resolves.toContain('[model_providers.volare]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('prunes old Volare backup files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-codex-config-'));
    const configPath = join(root, 'config.toml');
    await writeFile(configPath, 'profile = "first"\n');

    try {
      await configureCodex({ configPath, backupSuffix: '001', backupLimit: 2 });
      await writeFile(configPath, 'profile = "second"\n');
      await configureCodex({ configPath, backupSuffix: '002', backupLimit: 2 });
      await writeFile(configPath, 'profile = "third"\n');
      await configureCodex({ configPath, backupSuffix: '003', backupLimit: 2 });

      const backupDir = join(root, 'backups', 'volare');
      await expect(readFile(join(backupDir, 'config-001.toml'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(backupDir, 'config-002.toml'), 'utf8')).resolves.toBe(
        'profile = "second"\n',
      );
      await expect(readFile(join(backupDir, 'config-003.toml'), 'utf8')).resolves.toBe(
        'profile = "third"\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
