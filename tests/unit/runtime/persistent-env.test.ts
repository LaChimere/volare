import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  test('reads persisted certificate bundle environment overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-env-'));
    const env = { VOLARE_HOME: root };
    const envPath = defaultPersistentEnvPath(env);
    try {
      await writeFile(
        envPath,
        [
          'export VOLARE_API_KEY="0123456789abcdef0123456789abcdef"',
          'export SSL_CERT_FILE="/tmp/cacert.pem"',
          'export REQUESTS_CA_BUNDLE="/tmp/cacert.pem"',
          'export CURL_CA_BUNDLE="/tmp/cacert.pem"',
          'export IGNORED_SECRET="do-not-read"',
          '',
        ].join('\n'),
      );

      await expect(readPersistentRuntimeEnv(env)).resolves.toEqual({
        VOLARE_API_KEY: '0123456789abcdef0123456789abcdef',
        SSL_CERT_FILE: '/tmp/cacert.pem',
        REQUESTS_CA_BUNDLE: '/tmp/cacert.pem',
        CURL_CA_BUNDLE: '/tmp/cacert.pem',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('preserves persisted certificate bundle variables when writing API key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-env-'));
    const env = { VOLARE_HOME: root };
    const envPath = defaultPersistentEnvPath(env);
    try {
      await writeFile(
        envPath,
        [
          'export SSL_CERT_FILE="/tmp/cacert.pem"',
          'export REQUESTS_CA_BUNDLE="/tmp/cacert.pem"',
          'export CURL_CA_BUNDLE="/tmp/cacert.pem"',
          '',
        ].join('\n'),
      );

      await writePersistentApiKey('0123456789abcdef0123456789abcdef', env);

      await expect(readPersistentRuntimeEnv(env)).resolves.toEqual({
        VOLARE_API_KEY: '0123456789abcdef0123456789abcdef',
        SSL_CERT_FILE: '/tmp/cacert.pem',
        REQUESTS_CA_BUNDLE: '/tmp/cacert.pem',
        CURL_CA_BUNDLE: '/tmp/cacert.pem',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('round-trips escaped persistent environment values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volare-env-'));
    const env = { VOLARE_HOME: root };
    const envPath = defaultPersistentEnvPath(env);
    try {
      await writeFile(envPath, `${String.raw`export SSL_CERT_FILE="C:\\corp\\ca\"bundle.pem"`}\n`);

      await writePersistentApiKey('0123456789abcdef0123456789abcdef', env);

      await expect(readPersistentRuntimeEnv(env)).resolves.toMatchObject({
        SSL_CERT_FILE: 'C:\\corp\\ca"bundle.pem',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
