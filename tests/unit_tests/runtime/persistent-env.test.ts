import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultPersistentEnvPath,
  readPersistentRuntimeEnv,
  writePersistentApiKey,
} from '../../../src/runtime/persistent-env';

describe('persistent runtime env', () => {
  test('writes and reads a persisted Volare API key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-env-'));
    const env = { VOLARE_HOME: root };

    try {
      const envPath = await writePersistentApiKey('0123456789abcdef0123456789abcdef', env);

      expect(envPath).toBe(defaultPersistentEnvPath(env));
      await expect(readFile(envPath, 'utf8')).resolves.toBe(
        'export VOLARE_API_KEY="0123456789abcdef0123456789abcdef"\n',
      );
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
      await expect(readPersistentRuntimeEnv(env)).resolves.toEqual({
        VOLARE_API_KEY: '0123456789abcdef0123456789abcdef',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
