import type { IBackendCapabilities } from './types';

export type CapabilitySupport = 'unknown' | 'unsupported' | 'supported';
export type CapabilityObservationSource = 'unknown' | 'config' | 'probe';
export type ApprovalWaiterMode = 'polling' | 'notifier';
export type AcpNativeCancelClassification =
  | 'unknown'
  | 'unsupported'
  | 'native-terminal-only'
  | 'native-reusable';

export interface ICapabilityObservation {
  support: CapabilitySupport;
  source: CapabilityObservationSource;
  updatedAt: number;
  reason?: string;
}

export interface IAcpNativeCancelObservation extends ICapabilityObservation {
  classification: AcpNativeCancelClassification;
}

export interface IRuntimeCapabilitySnapshot {
  revision: number;
  updatedAt: number;
  runtime: {
    mode: string;
    acceptingNewWork: boolean;
    activeTurnCapacity: {
      enabled: boolean;
      limit: number | null;
    };
    approvalResolution: {
      supported: boolean;
      waiter: 'polling' | 'notifier';
    };
  };
  backend: {
    name: string;
    capabilities: IBackendCapabilities;
    updatedAt: number;
  } | null;
  acp: {
    nativeCancel: IAcpNativeCancelObservation;
  };
}

export interface IRuntimeCapabilityRegistry {
  snapshot(): IRuntimeCapabilitySnapshot;
  updateRuntimeMode(mode: string): void;
  updateBackend(input: { name: string; capabilities: IBackendCapabilities }): void;
  clearBackend(reason: string): void;
  updateApprovalWaiter(mode: ApprovalWaiterMode): void;
  updateAcpNativeCancel(input: {
    classification: AcpNativeCancelClassification;
    source: CapabilityObservationSource;
    reason?: string;
  }): void;
  invalidateAcpNativeCancel(reason: string): void;
  markShutdown(reason?: string): void;
}

export class RuntimeCapabilityRegistry implements IRuntimeCapabilityRegistry {
  readonly #now: () => number;
  #revision = 0;
  #updatedAt: number;
  #runtimeMode: string;
  #acceptingNewWork = true;
  #maxActiveTurns: number | null;
  #approvalWaiter: ApprovalWaiterMode;
  #backend: IRuntimeCapabilitySnapshot['backend'] = null;
  #acpNativeCancel: IAcpNativeCancelObservation;

  constructor(options: {
    runtimeMode: string;
    maxActiveTurns: number | null;
    approvalWaiter?: ApprovalWaiterMode;
    now?: () => number;
  }) {
    this.#now = options.now ?? Date.now;
    this.#runtimeMode = options.runtimeMode;
    this.#maxActiveTurns = options.maxActiveTurns;
    this.#approvalWaiter = options.approvalWaiter ?? 'polling';
    this.#updatedAt = this.#now();
    this.#acpNativeCancel = this.#unknownAcpNativeCancel('not_observed');
  }

  snapshot(): IRuntimeCapabilitySnapshot {
    return {
      revision: this.#revision,
      updatedAt: this.#updatedAt,
      runtime: {
        mode: this.#runtimeMode,
        acceptingNewWork: this.#acceptingNewWork,
        activeTurnCapacity: {
          enabled: Number.isFinite(this.#maxActiveTurns),
          limit: this.#maxActiveTurns,
        },
        approvalResolution: {
          supported: true,
          waiter: this.#approvalWaiter,
        },
      },
      backend: this.#backend
        ? {
            name: this.#backend.name,
            capabilities: { ...this.#backend.capabilities },
            updatedAt: this.#backend.updatedAt,
          }
        : null,
      acp: {
        nativeCancel: { ...this.#acpNativeCancel },
      },
    };
  }

  updateRuntimeMode(mode: string): void {
    if (this.#runtimeMode === mode) {
      return;
    }
    this.#runtimeMode = mode;
    this.#backend = null;
    this.#acpNativeCancel = this.#unknownAcpNativeCancel('runtime_mode_changed');
    this.#touch();
  }

  updateBackend(input: { name: string; capabilities: IBackendCapabilities }): void {
    this.#backend = {
      name: input.name,
      capabilities: { ...input.capabilities },
      updatedAt: this.#now(),
    };
    this.#touch();
  }

  clearBackend(reason: string): void {
    this.#backend = null;
    this.#acpNativeCancel = this.#unknownAcpNativeCancel(reason);
    this.#touch();
  }

  updateApprovalWaiter(mode: ApprovalWaiterMode): void {
    if (this.#approvalWaiter === mode) {
      return;
    }
    this.#approvalWaiter = mode;
    this.#touch();
  }

  updateAcpNativeCancel(input: {
    classification: AcpNativeCancelClassification;
    source: CapabilityObservationSource;
    reason?: string;
  }): void {
    this.#acpNativeCancel = {
      classification: input.classification,
      support: supportForAcpNativeCancel(input.classification),
      source: input.source,
      updatedAt: this.#now(),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    this.#touch();
  }

  invalidateAcpNativeCancel(reason: string): void {
    this.#acpNativeCancel = this.#unknownAcpNativeCancel(reason);
    this.#touch();
  }

  markShutdown(reason = 'shutdown'): void {
    this.#acceptingNewWork = false;
    this.#backend = null;
    this.#acpNativeCancel = this.#unknownAcpNativeCancel(reason);
    this.#touch();
  }

  #unknownAcpNativeCancel(reason: string): IAcpNativeCancelObservation {
    return {
      classification: 'unknown',
      support: 'unknown',
      source: 'unknown',
      reason,
      updatedAt: this.#now(),
    };
  }

  #touch(): void {
    this.#revision += 1;
    this.#updatedAt = this.#now();
  }
}

export function supportForAcpNativeCancel(
  classification: AcpNativeCancelClassification,
): CapabilitySupport {
  switch (classification) {
    case 'native-reusable':
      return 'supported';
    case 'native-terminal-only':
    case 'unsupported':
      return 'unsupported';
    case 'unknown':
      return 'unknown';
  }
}
