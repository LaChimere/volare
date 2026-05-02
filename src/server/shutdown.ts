import type {
  ShutdownControllerInterface,
  ShutdownResultInterface,
  StateStoreInterface,
} from '../core/types';

export interface ShutdownServerInterface {
  stop(force?: boolean): void | Promise<void>;
}

export interface ShutdownControllerOptionsInterface {
  server: ShutdownServerInterface;
  stateStore: StateStoreInterface;
}

export class ShutdownController implements ShutdownControllerInterface {
  readonly #server: ShutdownServerInterface;
  readonly #stateStore: StateStoreInterface;
  #started = false;
  #result: Promise<ShutdownResultInterface> | null = null;

  constructor(options: ShutdownControllerOptionsInterface) {
    this.#server = options.server;
    this.#stateStore = options.stateStore;
  }

  shutdown(): Promise<ShutdownResultInterface> {
    if (this.#result) {
      return this.#result;
    }
    this.#started = true;
    this.#result = this.#shutdown();
    return this.#result;
  }

  async #shutdown(): Promise<ShutdownResultInterface> {
    await this.#server.stop(false);
    const result = await this.#stateStore.recoverStartupState();
    await this.#server.stop(true);
    return result;
  }

  get started(): boolean {
    return this.#started;
  }
}
