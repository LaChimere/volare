import { Database } from 'bun:sqlite';

import { DurableSessionManager } from '../../src/core/durable-session-manager';
import { InMemorySessionManager } from '../../src/core/in-memory-session-manager';
import type { IWorkspace, IWorkspaceResolver } from '../../src/core/types';
import { SQLiteEventJournal } from '../../src/events/sqlite-event-journal';
import { createApp, type IAppDependencies } from '../../src/server/app';
import { createServerRuntimeConfig } from '../../src/server/config';
import { migrate } from '../../src/state/migrations';
import { SQLiteStateStore } from '../../src/state/sqlite-store';
import { MockBackend } from './backends/mock-backend';

export { CapturingLogger } from './capturing-logger';

export const testApiKey = '0123456789abcdef';
export const testConfig = createServerRuntimeConfig({
  VOLARE_API_KEY: testApiKey,
  VOLARE_WORKSPACE_ROOT: process.cwd(),
});

export function authHeaders(init: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${testApiKey}`, ...init };
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8000${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...init.headers,
    },
  });
}

export function createStateStore(): SQLiteStateStore {
  const database = new Database(':memory:');
  migrate(database);
  return new SQLiteStateStore(database);
}

export function createInMemoryApp(
  overrides: Partial<IAppDependencies> = {},
  backend: MockBackend = new MockBackend(),
) {
  const workspace: IWorkspace = {
    id: 'workspace_test',
    rootPath: process.cwd(),
  };
  const workspaceResolver: IWorkspaceResolver = {
    async resolve() {
      return workspace;
    },
  };

  return createApp({
    config: testConfig,
    workspaceResolver,
    sessionManager: new InMemorySessionManager({
      backend,
      workspace,
    }),
    ...overrides,
  });
}

export function createDurableApp(
  stateStore: SQLiteStateStore,
  overrides: Partial<IAppDependencies> = {},
  backend: MockBackend = new MockBackend(),
) {
  const eventJournal = overrides.eventJournal ?? new SQLiteEventJournal(stateStore.database);
  const sessionManager =
    overrides.sessionManager ??
    new DurableSessionManager({
      store: stateStore,
      backend,
      ...(overrides.logger ? { logger: overrides.logger } : {}),
    });
  return createApp({
    config: testConfig,
    stateStore,
    eventJournal,
    sessionManager,
    ...overrides,
  });
}
