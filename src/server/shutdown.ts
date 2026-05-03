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
    await this.#server.stop(false);
    try {
      return await this.#stateStore.recoverStartupState();
    } finally {
      await this.#server.stop(true);
    }
  }

  get started(): boolean {
    return this.#started;
  }
}
