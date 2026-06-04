import { describe, expect, test } from 'bun:test';

import { AcpCopilotPromptRunner } from '../../../src/backends/copilot-cli/acp-runner';
import { BunCopilotPromptRunner } from '../../../src/backends/copilot-cli/backend';
import { NoopLogger } from '../../../src/logging/logger';
import { createCopilotPromptRunner, mergeRuntimeEnv } from '../../../src/runtime/server';
import { createServerRuntimeConfig } from '../../../src/server/config';

describe('runtime server wiring', () => {
  test('keeps process runner as the default', () => {
    const config = createServerRuntimeConfig({});

    expect(createCopilotPromptRunner(config, new NoopLogger())).toBeInstanceOf(
      BunCopilotPromptRunner,
    );
  });

  test('creates ACP runner only when explicitly configured', () => {
    const config = createServerRuntimeConfig({
      VOLARE_COPILOT_RUNTIME_MODE: 'acp',
      VOLARE_COPILOT_ACP_MAX_WORKERS: '2',
      VOLARE_MAX_ACTIVE_SESSIONS: '3',
    });

    expect(createCopilotPromptRunner(config, new NoopLogger())).toBeInstanceOf(
      AcpCopilotPromptRunner,
    );
  });

  test('merges runtime env without overwriting persisted values with undefined', () => {
    expect(
      mergeRuntimeEnv(
        {
          VOLARE_API_KEY: 'persisted-api-key',
          SSL_CERT_FILE: '/persisted/cert.pem',
        },
        {
          VOLARE_API_KEY: undefined,
          SSL_CERT_FILE: undefined,
          REQUESTS_CA_BUNDLE: '/process/cert.pem',
        },
        {
          REQUESTS_CA_BUNDLE: undefined,
          CURL_CA_BUNDLE: '/override/cert.pem',
        },
      ),
    ).toEqual({
      VOLARE_API_KEY: 'persisted-api-key',
      SSL_CERT_FILE: '/persisted/cert.pem',
      REQUESTS_CA_BUNDLE: '/process/cert.pem',
      CURL_CA_BUNDLE: '/override/cert.pem',
    });
  });
});
