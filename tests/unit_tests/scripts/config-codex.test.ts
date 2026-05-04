import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCodexConfig, configureCodex } from '../../../scripts/config-codex';

describe('config-codex script', () => {
  test('builds Codex Agent Loom config while preserving unrelated sections', () => {
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

    expect(config).toContain('profile = "agent-loom"');
    expect(config).toContain('model_provider = "agent-loom"');
    expect(config).toContain('model = "copilot-agent"');
    expect(config).toContain('[model_providers.other]');
    expect(config).toContain('[profiles.other]');
    expect(config).toContain('[model_providers.agent-loom]');
    expect(config).toContain('base_url = "http://127.0.0.1:8000/openai/v1"');
    expect(config).toContain('env_key = "AGENT_LOOM_API_KEY"');
    expect(config).toContain('requires_openai_auth = true');
    expect(config).toContain('[profiles.agent-loom]');
  });

  test('replaces existing Agent Loom sections instead of duplicating them', () => {
    const config = buildCodexConfig(
      [
        'profile = "old"',
        'model_provider = "old"',
        'model = "old"',
        '',
        '[model_providers.agent-loom]',
        'name = "Old Agent Loom"',
        'base_url = "http://127.0.0.1:1/openai/v1"',
        '',
        '[profiles.agent-loom]',
        'model_provider = "old"',
        'model = "old"',
      ].join('\n'),
      {
        baseUrl: 'http://127.0.0.1:8765/openai/v1',
        envKey: 'CUSTOM_AGENT_LOOM_API_KEY',
      },
    );

    expect(config.match(/\[model_providers\.agent-loom\]/g)).toHaveLength(1);
    expect(config.match(/\[profiles\.agent-loom\]/g)).toHaveLength(1);
    expect(config).not.toContain('Old Agent Loom');
    expect(config).toContain('base_url = "http://127.0.0.1:8765/openai/v1"');
    expect(config).toContain('env_key = "CUSTOM_AGENT_LOOM_API_KEY"');
  });

  test('writes config and backs up an existing file only when changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-loom-codex-config-'));
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
        backupPath: `${configPath}.agent-loom-backup-test`,
      });
      expect(second).toEqual({
        configPath,
        changed: false,
      });
      await expect(readFile(`${configPath}.agent-loom-backup-test`, 'utf8')).resolves.toBe(
        'profile = "other"\n',
      );
      await expect(readFile(configPath, 'utf8')).resolves.toContain('[model_providers.agent-loom]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
