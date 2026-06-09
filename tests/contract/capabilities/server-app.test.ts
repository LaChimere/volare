import { describe, expect, test } from 'bun:test';

import { RuntimeCapabilityRegistry } from '../../../src/core/runtime-capability-registry';
import { createApp } from '../../../src/server/app';
import { createServerRuntimeConfig } from '../../../src/server/config';
import { request } from '../../support/app-harness';

describe('server app capabilities contract', () => {
  test('serves a stable versioned capabilities schema', async () => {
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      approvalWaiter: 'notifier',
      now: () => 1000,
    });
    capabilityRegistry.updateBackend({
      name: 'copilot-cli',
      capabilities: {
        persistentSessions: true,
        serverSideTools: true,
        permissionRequests: true,
        externalApprovalDecisions: false,
        backendInternalPauseResume: true,
        cancellation: true,
      },
    });
    capabilityRegistry.updateAcpNativeCancel({
      classification: 'native-terminal-only',
      source: 'probe',
      reason: 'diagnostic detail must stay private',
    });
    const app = createApp({
      config: createServerRuntimeConfig({
        VOLARE_API_KEY: '0123456789abcdef',
        VOLARE_WORKSPACE_ROOT: process.cwd(),
        VOLARE_COPILOT_RUNTIME_MODE: 'acp',
      }),
      capabilityRegistry,
      healthStatus: () => 'ready',
    });

    const response = await app.fetch(request('/capabilities'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      schema_version: 1,
      server: {
        name: 'volare',
        status: 'ready',
      },
      protocols: {
        openai_responses: {
          cancellation: true,
          client_side_tool_calls: false,
          streaming: true,
          resumable_turns: false,
        },
      },
      runtime: {
        mode: 'acp',
        accepting_new_work: true,
        active_turn_capacity: {
          enabled: true,
          limit: 2,
        },
        approval_resolution: {
          supported: true,
          waiter: 'notifier',
        },
        sse_resume: false,
      },
      backend: {
        name: 'copilot-cli',
        capabilities: {
          backend_internal_pause_resume: true,
          cancellation: true,
          external_approval_decisions: false,
          permission_requests: true,
          persistent_sessions: true,
          server_side_tools: true,
        },
      },
      acp: {
        native_cancel: {
          classification: 'native-terminal-only',
          support: 'unsupported',
          source: 'probe',
        },
      },
      security: {
        bearer_auth: true,
        cors_mode: 'disabled',
        loopback_only: true,
      },
    });
  });
});
