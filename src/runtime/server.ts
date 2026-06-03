import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DefaultApprovalPolicy } from '../approvals/policy';
import { ApprovalProvider } from '../approvals/provider';
import { CopilotCliBackend } from '../backends/copilot-cli/backend';
import { DurableSessionManager } from '../core/durable-session-manager';
import { toVolareError } from '../core/errors';
import { SQLiteEventJournal } from '../events/sqlite-event-journal';
import { createLogger } from '../logging/logger';
import { createApp } from '../server/app';
import {
  createServerRuntimeConfig,
  type IServerRuntimeConfig,
  type IServerRuntimeEnv,
  readServerRuntimeEnv,
} from '../server/config';
import { ShutdownController } from '../server/shutdown';
import { migrate } from '../state/migrations';
import { SQLiteStateStore } from '../state/sqlite-store';
import { readPersistentRuntimeEnv } from './persistent-env';

export interface IVolareRuntimeOptions {
  env?: Partial<IServerRuntimeEnv>;
}

export interface IVolareRuntime {
  config: IServerRuntimeConfig;
  server: ReturnType<typeof Bun.serve>;
  shutdown: ShutdownController;
}

export async function startVolareRuntime(
  options: IVolareRuntimeOptions = {},
): Promise<IVolareRuntime> {
  const config = createServerRuntimeConfig({
    ...(await readPersistentRuntimeEnv()),
    ...readServerRuntimeEnv(),
    ...options.env,
  });
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
    backend: new CopilotCliBackend({
      logger,
      permissionMode: config.copilotPermissionMode,
      mcpMode: config.copilotMcpMode,
    }),
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
    console.error(`Volare API token: ${config.apiKey}`);
  }
  if (config.copilotMcpMode === 'unmediated') {
    runtimeLogger.warn(
      {
        event: 'runtime.unmediated_mcp.enabled',
        copilotMcpMode: config.copilotMcpMode,
        copilotPermissionMode: config.copilotPermissionMode,
        unmediatedToolingEnabled: true,
      },
      'Copilot builtin MCPs are enabled without Volare approval mediation',
    );
  }

  runtimeLogger.info(
    {
      event: 'runtime.starting',
      host: config.host,
      port: config.port,
      stateDatabasePath: config.stateDatabasePath,
      httpIdleTimeoutSeconds: config.httpIdleTimeoutSeconds,
      copilotPermissionMode: config.copilotPermissionMode,
      copilotMcpMode: config.copilotMcpMode,
      copilotRuntimeMode: config.copilotRuntimeMode,
      copilotAcpMaxWorkers: config.copilotAcpMaxWorkers,
      logLevel: config.logLevel,
    },
    'Volare starting',
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
    'Volare listening',
  );
  return { config, server, shutdown };
}

export function installRuntimeSignalHandlers(runtime: IVolareRuntime): void {
  const runtimeLogger = createLogger({ level: runtime.config.logLevel }).child({
    component: 'runtime',
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      try {
        runtimeLogger.info({ event: 'runtime.shutdown.started', signal }, 'Volare shutting down');
        await runtime.shutdown.shutdown();
        runtimeLogger.info(
          { event: 'runtime.shutdown.completed', signal },
          'Volare shutdown complete',
        );
        process.exit(0);
      } catch (error) {
        const agentError = toVolareError(error);
        runtimeLogger.error(
          {
            event: 'runtime.shutdown.failed',
            signal,
            errorCode: agentError.code,
            error: agentError,
          },
          'Volare shutdown failed',
        );
        process.exit(1);
      }
    });
  }
}
