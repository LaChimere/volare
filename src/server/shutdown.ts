import type { IShutdownController, IShutdownResult, IStateStore } from '../core/types';

export interface IShutdownServer {
  stop(force?: boolean): void | Promise<void>;
}

export interface IShutdownControllerOptions {
  server: IShutdownServer;
  stateStore: IStateStore;
}

export class ShutdownController implements IShutdownController {
  readonly #server: IShutdownServer;
  readonly #stateStore: IStateStore;
  #started = false;
  #result: Promise<IShutdownResult> | null = null;

  constructor(options: IShutdownControllerOptions) {
    this.#server = options.server;
    this.#stateStore = options.stateStore;
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
    try {
      await this.#server.stop(false);
    } catch (error) {
      errors.push(error);
    }
    try {
      result = await this.#stateStore.recoverStartupState();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#server.stop(true);
    } catch (error) {
      errors.push(error);
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
    return result;
  }

  get started(): boolean {
    return this.#started;
  }
}
