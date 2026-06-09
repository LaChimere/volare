import { describe, expect, test } from 'bun:test';

import {
  RuntimeCapabilityRegistry,
  supportForAcpNativeCancel,
} from '../../../src/core/runtime-capability-registry';
import type { IBackendCapabilities } from '../../../src/core/types';

function backendCapabilities(overrides: Partial<IBackendCapabilities> = {}): IBackendCapabilities {
  return {
    persistentSessions: false,
    serverSideTools: false,
    permissionRequests: true,
    externalApprovalDecisions: false,
    backendInternalPauseResume: true,
    cancellation: true,
    ...overrides,
  };
}

describe('RuntimeCapabilityRegistry', () => {
  test('creates immutable snapshots of runtime and backend capabilities', () => {
    let now = 1000;
    const registry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      approvalWaiter: 'notifier',
      now: () => now,
    });
    const capabilities = backendCapabilities({ persistentSessions: true });
    now = 1100;
    registry.updateBackend({ name: 'copilot-cli', capabilities });
    capabilities.persistentSessions = false;

    const snapshot = registry.snapshot();

    expect(snapshot).toMatchObject({
      revision: 1,
      updatedAt: 1100,
      runtime: {
        mode: 'acp',
        acceptingNewWork: true,
        activeTurnCapacity: { enabled: true, limit: 2 },
        approvalResolution: { supported: true, waiter: 'notifier' },
      },
      backend: {
        name: 'copilot-cli',
        capabilities: { persistentSessions: true },
        updatedAt: 1100,
      },
      acp: {
        nativeCancel: {
          classification: 'unknown',
          support: 'unknown',
          source: 'unknown',
          reason: 'not_observed',
        },
      },
    });
    const snapshotBackend = snapshot.backend;
    if (!snapshotBackend) {
      throw new Error('expected backend capabilities in snapshot');
    }
    snapshotBackend.capabilities.persistentSessions = false;
    expect(registry.snapshot().backend?.capabilities.persistentSessions).toBe(true);
  });

  test('invalidates backend and ACP observations on boundary changes', () => {
    let now = 2000;
    const registry = new RuntimeCapabilityRegistry({
      runtimeMode: 'process',
      maxActiveTurns: null,
      now: () => now,
    });
    registry.updateBackend({ name: 'copilot-cli', capabilities: backendCapabilities() });
    now = 2100;
    registry.updateAcpNativeCancel({
      classification: 'native-reusable',
      source: 'probe',
      reason: 'probe_success',
    });
    expect(registry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'native-reusable',
      support: 'supported',
      source: 'probe',
      reason: 'probe_success',
      updatedAt: 2100,
    });

    now = 2200;
    registry.updateRuntimeMode('acp');

    expect(registry.snapshot()).toMatchObject({
      revision: 3,
      updatedAt: 2200,
      runtime: {
        mode: 'acp',
        acceptingNewWork: true,
        activeTurnCapacity: { enabled: false, limit: null },
      },
      backend: null,
      acp: {
        nativeCancel: {
          classification: 'unknown',
          support: 'unknown',
          source: 'unknown',
          reason: 'runtime_mode_changed',
          updatedAt: 2200,
        },
      },
    });

    registry.updateRuntimeMode('acp');
    expect(registry.snapshot().revision).toBe(3);
  });

  test('records approval waiter changes, shutdown state, and cancel support mapping', () => {
    let now = 3000;
    const registry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 1,
      now: () => now,
    });

    now = 3100;
    registry.updateApprovalWaiter('notifier');
    now = 3200;
    registry.markShutdown('test_shutdown');

    expect(registry.snapshot()).toMatchObject({
      revision: 2,
      updatedAt: 3200,
      runtime: {
        acceptingNewWork: false,
        approvalResolution: { supported: true, waiter: 'notifier' },
      },
      backend: null,
      acp: {
        nativeCancel: {
          classification: 'unknown',
          support: 'unknown',
          source: 'unknown',
          reason: 'test_shutdown',
          updatedAt: 3200,
        },
      },
    });
    expect(supportForAcpNativeCancel('unknown')).toBe('unknown');
    expect(supportForAcpNativeCancel('unsupported')).toBe('unsupported');
    expect(supportForAcpNativeCancel('native-terminal-only')).toBe('unsupported');
    expect(supportForAcpNativeCancel('native-reusable')).toBe('supported');
  });
});
