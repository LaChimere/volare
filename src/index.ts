import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DefaultApprovalPolicy } from './approvals/policy';
import { ApprovalProvider } from './approvals/provider';
import { CopilotCliBackend } from './backends/copilot-cli/backend';
import { DurableSessionManager } from './core/durable-session-manager';
import { SQLiteEventJournal } from './events/sqlite-event-journal';
import { createApp } from './server/app';
import { createServerRuntimeConfig } from './server/config';
import { ShutdownController } from './server/shutdown';
import { migrate } from './state/migrations';
import { SQLiteStateStore } from './state/sqlite-store';

const config = createServerRuntimeConfig();
if (config.stateDatabasePath !== ':memory:') {
  await mkdir(path.dirname(config.stateDatabasePath), { recursive: true });
}
const database = new Database(config.stateDatabasePath);
migrate(database);
const stateStore = new SQLiteStateStore(database);
const eventJournal = new SQLiteEventJournal(database);
await stateStore.recoverStartupState();
const sessionManager = new DurableSessionManager({
  store: stateStore,
  backend: new CopilotCliBackend(),
  approvalProvider: new ApprovalProvider({
    store: stateStore,
    policy: new DefaultApprovalPolicy({ timeoutMs: config.approvalTimeoutMs }),
  }),
  cancelTimeoutMs: config.cancelTimeoutMs,
});

if (config.generatedApiKey) {
  console.error(`Agent Loom API token: ${config.apiKey}`);
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createApp({ config, stateStore, eventJournal, sessionManager }).fetch,
});
const shutdown = new ShutdownController({ server, stateStore });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    try {
      await shutdown.shutdown();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
}

console.error(`Agent Loom listening on http://${config.host}:${config.port}`);
