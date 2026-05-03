import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DefaultApprovalPolicy } from '../approvals/policy';
import { ApprovalProvider } from '../approvals/provider';
import { CopilotCliBackend } from '../backends/copilot-cli/backend';
import { DurableSessionManager } from '../core/durable-session-manager';
import { toAgentLoomError } from '../core/errors';
import { SQLiteEventJournal } from '../events/sqlite-event-journal';
import { createLogger } from '../logging/logger';
import { createApp } from '../server/app';
import {
  createServerRuntimeConfig,
  type ServerRuntimeConfigInterface,
  type ServerRuntimeEnvInterface,
} from '../server/config';
import { ShutdownController } from '../server/shutdown';
import { migrate } from '../state/migrations';
import { SQLiteStateStore } from '../state/sqlite-store';

export interface AgentLoomRuntimeOptionsInterface {
  env?: Partial<ServerRuntimeEnvInterface>;
}

export interface AgentLoomRuntimeInterface {
  config: ServerRuntimeConfigInterface;
  server: ReturnType<typeof Bun.serve>;
  shutdown: ShutdownController;
}

export async function startAgentLoomRuntime(
  options: AgentLoomRuntimeOptionsInterface = {},
): Promise<AgentLoomRuntimeInterface> {
  const config = createServerRuntimeConfig(options.env);
  const logger = createLogger({ level: config.logLevel });
  const runtimeLogger = logger.child({ component: 'runtime' });
  if (config.stateDatabasePath !== ':memory:') {
    await mkdir(path.dirname(config.stateDatabasePath), { recursive: true });
  }
  const database = new Database(config.stateDatabasePath);
  migrate(database);
  const stateStore = new SQLiteStateStore(database);
  const eventJournal = new SQLiteEventJournal(database, undefined, logger);
  await stateStore.recoverStartupState();
  const sessionManager = new DurableSessionManager({
    store: stateStore,
    backend: new CopilotCliBackend({ logger }),
    approvalProvider: new ApprovalProvider({
      store: stateStore,
      policy: new DefaultApprovalPolicy({ timeoutMs: config.approvalTimeoutMs }),
      logger,
    }),
    cancelTimeoutMs: config.cancelTimeoutMs,
    logger,
  });

  if (config.generatedApiKey) {
    runtimeLogger.warn({ event: 'runtime.api_key.generated' }, 'ephemeral API key generated');
    console.error(`Agent Loom API token: ${config.apiKey}`);
  }

  runtimeLogger.info(
    {
      event: 'runtime.starting',
      host: config.host,
      port: config.port,
      stateDatabasePath: config.stateDatabasePath,
      httpIdleTimeoutSeconds: config.httpIdleTimeoutSeconds,
      logLevel: config.logLevel,
    },
    'Agent Loom starting',
  );
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: config.httpIdleTimeoutSeconds,
    fetch: createApp({ config, stateStore, eventJournal, sessionManager, logger }).fetch,
  });
  const shutdown = new ShutdownController({ server, stateStore });
  runtimeLogger.info(
    { event: 'runtime.listening', host: config.host, port: config.port },
    'Agent Loom listening',
  );
  return { config, server, shutdown };
}

export function installRuntimeSignalHandlers(runtime: AgentLoomRuntimeInterface): void {
  const runtimeLogger = createLogger({ level: runtime.config.logLevel }).child({
    component: 'runtime',
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      try {
        runtimeLogger.info(
          { event: 'runtime.shutdown.started', signal },
          'Agent Loom shutting down',
        );
        await runtime.shutdown.shutdown();
        runtimeLogger.info(
          { event: 'runtime.shutdown.completed', signal },
          'Agent Loom shutdown complete',
        );
        process.exit(0);
      } catch (error) {
        const agentError = toAgentLoomError(error);
        runtimeLogger.error(
          {
            event: 'runtime.shutdown.failed',
            signal,
            errorCode: agentError.code,
            error: agentError,
          },
          'Agent Loom shutdown failed',
        );
        process.exit(1);
      }
    });
  }
}
