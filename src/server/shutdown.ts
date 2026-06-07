import type {
  IApprovalNotifier,
  IShutdownController,
  IShutdownResult,
  IStateStore,
} from '../core/types';

export interface IShutdownServer {
  stop(force?: boolean): void | Promise<void>;
}

export interface IShutdownControllerOptions {
  server: IShutdownServer;
  stateStore: IStateStore;
  approvalNotifier?: IApprovalNotifier;
  gracefulStopTimeoutMs?: number;
  cleanup?: () => void | Promise<void>;
}

export class ShutdownController implements IShutdownController {
  readonly #server: IShutdownServer;
  readonly #stateStore: IStateStore;
  readonly #approvalNotifier: IApprovalNotifier | undefined;
  readonly #gracefulStopTimeoutMs: number;
  readonly #cleanup: (() => void | Promise<void>) | undefined;
  #started = false;
  #result: Promise<IShutdownResult> | null = null;

  constructor(options: IShutdownControllerOptions) {
    this.#server = options.server;
    this.#stateStore = options.stateStore;
    this.#approvalNotifier = options.approvalNotifier;
    this.#gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? 30_000;
    this.#cleanup = options.cleanup;
  }

  shutdown(): Promise<IShutdownResult> {
    if (this.#result) {
      return this.#result;
    }
    this.#started = true;
    this.#result = this.#shutdown();
    return this.#result;
  }

  async #shutdown(): Promise<IShutdownResult> {
    const errors: unknown[] = [];
    let result: IShutdownResult | undefined;
    let abortedApprovalCount = 0;
    let gracefulStop: Promise<void> | undefined;
    let gracefulStopError: unknown;
    try {
      gracefulStop = Promise.resolve(this.#server.stop(false)).catch((error) => {
        gracefulStopError = error;
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      const approvalAbortResult = await this.#approvalNotifier?.abortPendingApprovals({
        reason: 'shutdown',
      });
      abortedApprovalCount += approvalAbortResult?.abortedApprovalCount ?? 0;
    } catch (error) {
      errors.push(error);
    }
    try {
      await waitForGracefulStop(gracefulStop, this.#gracefulStopTimeoutMs);
      if (gracefulStopError) {
        errors.push(gracefulStopError);
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#cleanup?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      result = await this.#stateStore.recoverStartupState({ approvalAbortReason: 'shutdown' });
      abortedApprovalCount += result.abortedApprovalCount;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#server.stop(true);
    } catch (error) {
      errors.push(error);
    }
    if (gracefulStopError && !errors.includes(gracefulStopError)) {
      errors.push(gracefulStopError);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Shutdown failed');
    }
    if (!result) {
      throw new Error('Shutdown did not produce a recovery result');
    }
    return { ...result, abortedApprovalCount };
  }

  get started(): boolean {
    return this.#started;
  }
}

async function waitForGracefulStop(
  gracefulStop: Promise<void> | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!gracefulStop) {
    return;
  }
  if (timeoutMs <= 0) {
    await gracefulStop;
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void gracefulStop.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
