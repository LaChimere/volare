import { VolareError } from '../../core/errors';
import { type ILogger, NoopLogger } from '../../logging/logger';

export interface IWorkerAdmissionLease {
  release(): void;
}

export interface IWorkerAdmissionSnapshot {
  maxActive: number;
  active: number;
  queueDepth: number;
  grantedTotal: number;
  queuedTotal: number;
  timeoutTotal: number;
  cancelledTotal: number;
  shutdownTotal: number;
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
  readonly #logger: ILogger;
  readonly #queue: IAdmissionEntry[] = [];
  #active = 0;
  #closedReason: string | null = null;
  #grantedTotal = 0;
  #queuedTotal = 0;
  #timeoutTotal = 0;
  #cancelledTotal = 0;
  #shutdownTotal = 0;

  constructor(options: { maxActive: number; timeoutMs: number; logger?: ILogger }) {
    this.#maxActive = options.maxActive;
    this.#timeoutMs = options.timeoutMs;
    this.#logger = (options.logger ?? new NoopLogger()).child({
      component: 'backend',
      backend: 'copilot-cli',
      queue: 'worker-admission',
    });
  }

  snapshot(): IWorkerAdmissionSnapshot {
    return {
      maxActive: this.#maxActive,
      active: this.#active,
      queueDepth: this.#queue.length,
      grantedTotal: this.#grantedTotal,
      queuedTotal: this.#queuedTotal,
      timeoutTotal: this.#timeoutTotal,
      cancelledTotal: this.#cancelledTotal,
      shutdownTotal: this.#shutdownTotal,
    };
  }

  async acquire(label: string, signal?: AbortSignal): Promise<IWorkerAdmissionLease> {
    if (this.#closedReason) {
      this.#shutdownTotal += 1;
      this.#logger.warn(
        {
          event: 'backend.acp.admission.shutdown_rejected',
          backendSessionId: label,
          reason: this.#closedReason,
          queueDepth: this.#queue.length,
          activeAdmissions: this.#active,
          maxAdmissions: this.#maxActive,
        },
        'ACP worker admission rejected during shutdown',
      );
      throw new VolareError('service_unavailable', 'ACP worker admission is shutting down', {
        cause: { retryAfterMs: 1000, reason: this.#closedReason },
      });
    }
    if (signal?.aborted) {
      this.#cancelledTotal += 1;
      throw new VolareError('backend_cancelled', 'ACP worker admission was cancelled');
    }
    if (this.#active < this.#maxActive) {
      this.#active += 1;
      this.#grantedTotal += 1;
      this.#logger.debug(
        {
          event: 'backend.acp.admission.granted',
          backendSessionId: label,
          queued: false,
          queueDepth: this.#queue.length,
          activeAdmissions: this.#active,
          maxAdmissions: this.#maxActive,
        },
        'ACP worker admission granted',
      );
      return this.#lease();
    }
    if (this.#timeoutMs <= 0) {
      this.#timeoutTotal += 1;
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
        this.#timeoutTotal += 1;
        this.#logger.warn(
          {
            event: 'backend.acp.admission.timed_out',
            backendSessionId: label,
            queueDepth: this.#queue.length,
            activeAdmissions: this.#active,
            maxAdmissions: this.#maxActive,
          },
          'ACP worker admission timed out',
        );
        rejectEntry(admissionTimeoutError(this.#timeoutMs));
      }, this.#timeoutMs);
      entry.onAbort = () => {
        this.#cancelledTotal += 1;
        this.#logger.info(
          {
            event: 'backend.acp.admission.cancelled',
            backendSessionId: label,
            reason: 'signal_aborted',
            queueDepth: this.#queue.length,
            activeAdmissions: this.#active,
            maxAdmissions: this.#maxActive,
          },
          'ACP worker admission cancelled',
        );
        rejectEntry(new VolareError('backend_cancelled', 'ACP worker admission was cancelled'));
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.#queue.push(entry);
      this.#queuedTotal += 1;
      this.#logger.info(
        {
          event: 'backend.acp.admission.queued',
          backendSessionId: label,
          queueDepth: this.#queue.length,
          activeAdmissions: this.#active,
          maxAdmissions: this.#maxActive,
        },
        'ACP worker admission queued',
      );
    });
  }

  cancel(label: string, reason = 'backend_session_disposed'): void {
    const entries = this.#queue.filter((entry) => entry.label === label);
    for (const entry of entries) {
      this.#removeEntry(entry);
      this.#cleanupEntry(entry);
      this.#cancelledTotal += 1;
      this.#logger.info(
        {
          event: 'backend.acp.admission.cancelled',
          backendSessionId: label,
          reason,
          queueDepth: this.#queue.length,
          activeAdmissions: this.#active,
          maxAdmissions: this.#maxActive,
        },
        'ACP worker admission cancelled',
      );
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
      this.#shutdownTotal += 1;
      this.#logger.warn(
        {
          event: 'backend.acp.admission.shutdown_rejected',
          backendSessionId: entry.label,
          reason,
          queueDepth: this.#queue.length,
          activeAdmissions: this.#active,
          maxAdmissions: this.#maxActive,
        },
        'ACP worker admission rejected during shutdown',
      );
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
        this.#cancelledTotal += 1;
        entry.reject(new VolareError('backend_cancelled', 'ACP worker admission was cancelled'));
        continue;
      }
      this.#active += 1;
      this.#grantedTotal += 1;
      this.#logger.debug(
        {
          event: 'backend.acp.admission.granted',
          backendSessionId: entry.label,
          queued: true,
          queueDepth: this.#queue.length,
          activeAdmissions: this.#active,
          maxAdmissions: this.#maxActive,
        },
        'ACP worker admission granted',
      );
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
