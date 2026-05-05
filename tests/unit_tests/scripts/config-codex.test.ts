import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCodexConfig, configureCodex } from '../../../scripts/config-codex';

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
        backupPath: `${configPath}.volare-backup-test`,
      });
      expect(second).toEqual({
        configPath,
        changed: false,
      });
      await expect(readFile(`${configPath}.volare-backup-test`, 'utf8')).resolves.toBe(
        'profile = "other"\n',
      );
      await expect(readFile(configPath, 'utf8')).resolves.toContain('[model_providers.volare]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
