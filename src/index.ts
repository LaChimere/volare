import { createApp } from './server/app';
import { createServerRuntimeConfig } from './server/config';

const config = createServerRuntimeConfig();

if (config.generatedApiKey) {
  console.error(`Agent Loom API token: ${config.apiKey}`);
}

Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createApp({ config }).fetch,
});

console.error(`Agent Loom listening on http://${config.host}:${config.port}`);
