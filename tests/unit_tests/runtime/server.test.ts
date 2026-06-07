import { describe, expect, test } from 'bun:test';

import { AcpCopilotPromptRunner } from '../../../src/backends/copilot-cli/acp-runner';
import { BunCopilotPromptRunner } from '../../../src/backends/copilot-cli/backend';
import { RuntimeCapabilityRegistry } from '../../../src/core/runtime-capability-registry';
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

  test('wires ACP runner capability observations into the internal registry', () => {
    const config = createServerRuntimeConfig({
      VOLARE_COPILOT_RUNTIME_MODE: 'acp',
    });
    const registry = new RuntimeCapabilityRegistry({
      runtimeMode: config.copilotRuntimeMode,
      maxActiveTurns: config.maxActiveSessions,
      now: () => 1000,
    });

    expect(createCopilotPromptRunner(config, new NoopLogger(), registry)).toBeInstanceOf(
      AcpCopilotPromptRunner,
    );

    expect(registry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'unknown',
      support: 'unknown',
      source: 'unknown',
      reason: 'not_observed',
    });
  });

  test('merges and invalidates internal runtime capability snapshots', () => {
    const registry = new RuntimeCapabilityRegistry({
      runtimeMode: 'process',
      maxActiveTurns: 3,
      now: () => 1000,
    });

    registry.updateBackend({
      name: 'copilot-cli',
      capabilities: {
        persistentSessions: false,
        serverSideTools: true,
        permissionRequests: true,
        externalApprovalDecisions: false,
        backendInternalPauseResume: true,
        cancellation: true,
      },
    });
    registry.updateAcpNativeCancel({
      classification: 'native-reusable',
      source: 'probe',
    });
    const merged = registry.snapshot();
    expect(merged.runtime.activeTurnCapacity).toEqual({ enabled: true, limit: 3 });
    expect(merged.backend).toMatchObject({
      name: 'copilot-cli',
      capabilities: { cancellation: true },
    });
    expect(merged.acp.nativeCancel).toMatchObject({
      classification: 'native-reusable',
      support: 'supported',
      source: 'probe',
    });

    registry.invalidateAcpNativeCancel('probe_rerun_started');
    expect(registry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'unknown',
      source: 'unknown',
      reason: 'probe_rerun_started',
    });

    registry.clearBackend('backend_session_disposed');
    expect(registry.snapshot()).toMatchObject({
      backend: null,
      acp: {
        nativeCancel: {
          classification: 'unknown',
          source: 'unknown',
          reason: 'backend_session_disposed',
        },
      },
    });

    registry.updateRuntimeMode('acp');
    expect(registry.snapshot()).toMatchObject({
      runtime: { mode: 'acp' },
      backend: null,
      acp: {
        nativeCancel: {
          classification: 'unknown',
          source: 'unknown',
          reason: 'runtime_mode_changed',
        },
      },
    });

    registry.markShutdown();
    expect(registry.snapshot()).toMatchObject({
      runtime: { acceptingNewWork: false },
      backend: null,
      acp: {
        nativeCancel: {
          classification: 'unknown',
          source: 'unknown',
          reason: 'shutdown',
        },
      },
    });
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
