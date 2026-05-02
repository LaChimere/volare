import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from './server/app';
import { createServerRuntimeConfig } from './server/config';
import { migrate } from './state/migrations';
import { SQLiteStateStore } from './state/sqlite-store';

const config = createServerRuntimeConfig();
if (config.stateDatabasePath !== ':memory:') {
  await mkdir(path.dirname(config.stateDatabasePath), { recursive: true });
}
const database = new Database(config.stateDatabasePath);
migrate(database);
const stateStore = new SQLiteStateStore(database);

if (config.generatedApiKey) {
  console.error(`Agent Loom API token: ${config.apiKey}`);
}

Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createApp({ config, stateStore }).fetch,
});

console.error(`Agent Loom listening on http://${config.host}:${config.port}`);
