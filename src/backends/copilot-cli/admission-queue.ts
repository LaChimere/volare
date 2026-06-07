import { VolareError } from '../../core/errors';

export interface IWorkerAdmissionLease {
  release(): void;
}

interface IAdmissionEntry {
  label: string;
  resolve(lease: IWorkerAdmissionLease): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  timeout?: Timer;
  onAbort?: () => void;
}

export class WorkerAdmissionQueue {
  readonly #maxActive: number;
  readonly #timeoutMs: number;
  readonly #queue: IAdmissionEntry[] = [];
  #active = 0;
  #closedReason: string | null = null;

  constructor(options: { maxActive: number; timeoutMs: number }) {
    this.#maxActive = options.maxActive;
    this.#timeoutMs = options.timeoutMs;
  }

  async acquire(label: string, signal?: AbortSignal): Promise<IWorkerAdmissionLease> {
    if (this.#closedReason) {
      throw new VolareError('service_unavailable', 'ACP worker admission is shutting down', {
        cause: { retryAfterMs: 1000, reason: this.#closedReason },
      });
    }
    if (signal?.aborted) {
      throw new VolareError('backend_cancelled', 'ACP worker admission was cancelled');
    }
    if (this.#active < this.#maxActive) {
      this.#active += 1;
      return this.#lease();
    }
    if (this.#timeoutMs <= 0) {
      throw admissionTimeoutError(this.#timeoutMs);
    }

    return await new Promise<IWorkerAdmissionLease>((resolve, reject) => {
      const entry: IAdmissionEntry = {
        label,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      const rejectEntry = (error: unknown) => {
        this.#removeEntry(entry);
        this.#cleanupEntry(entry);
        reject(error);
      };
      entry.timeout = setTimeout(() => {
        rejectEntry(admissionTimeoutError(this.#timeoutMs));
      }, this.#timeoutMs);
      entry.onAbort = () => {
        rejectEntry(new VolareError('backend_cancelled', 'ACP worker admission was cancelled'));
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  cancel(label: string, reason = 'backend_session_disposed'): void {
    const entries = this.#queue.filter((entry) => entry.label === label);
    for (const entry of entries) {
      this.#removeEntry(entry);
      this.#cleanupEntry(entry);
      entry.reject(
        new VolareError('backend_cancelled', 'ACP worker admission was cancelled', {
          cause: { reason },
        }),
      );
    }
  }

  shutdown(reason = 'shutdown'): void {
    this.#closedReason = reason;
    for (const entry of this.#queue.splice(0)) {
      this.#cleanupEntry(entry);
      entry.reject(
        new VolareError('service_unavailable', 'ACP worker admission is shutting down', {
          cause: { retryAfterMs: 1000, reason },
        }),
      );
    }
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    this.#drain();
  }

  #drain(): void {
    while (!this.#closedReason && this.#active < this.#maxActive && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      if (!entry) {
        return;
      }
      this.#cleanupEntry(entry);
      if (entry.signal?.aborted) {
        entry.reject(new VolareError('backend_cancelled', 'ACP worker admission was cancelled'));
        continue;
      }
      this.#active += 1;
      entry.resolve(this.#lease());
    }
  }

  #lease(): IWorkerAdmissionLease {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#release();
      },
    };
  }

  #removeEntry(entry: IAdmissionEntry): void {
    const index = this.#queue.indexOf(entry);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
  }

  #cleanupEntry(entry: IAdmissionEntry): void {
    if (entry.timeout) {
      clearTimeout(entry.timeout);
    }
    if (entry.onAbort) {
      entry.signal?.removeEventListener('abort', entry.onAbort);
    }
  }
}

function admissionTimeoutError(timeoutMs: number): VolareError {
  return new VolareError('backend_worker_admission_timeout', 'ACP worker admission timed out', {
    cause: {
      scope: 'backend_worker_admission',
      retryAfterMs: Math.max(1, timeoutMs),
    },
  });
}
