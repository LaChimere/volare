import type { IRuntimeCapabilityRegistry } from '../core/runtime-capability-registry';
import type { INorthboundCapabilities } from '../core/types';
import type { IServerRuntimeConfig } from './config';

export function encodeCapabilitiesResponse(input: {
  config: IServerRuntimeConfig;
  adapterCapabilities: INorthboundCapabilities;
  capabilityRegistry: IRuntimeCapabilityRegistry | undefined;
  healthStatus: 'recovering' | 'ready';
}): Response {
  const snapshot = input.capabilityRegistry?.snapshot();
  return Response.json(
    {
      schema_version: 1,
      server: {
        name: 'volare',
        status: input.healthStatus,
      },
      protocols: {
        openai_responses: snakeCaseCapabilities(input.adapterCapabilities),
      },
      runtime: snapshot
        ? {
            mode: snapshot.runtime.mode,
            accepting_new_work: snapshot.runtime.acceptingNewWork,
            active_turn_capacity: {
              enabled: snapshot.runtime.activeTurnCapacity.enabled,
              limit: snapshot.runtime.activeTurnCapacity.limit,
            },
            approval_resolution: {
              supported: snapshot.runtime.approvalResolution.supported,
              waiter: snapshot.runtime.approvalResolution.waiter,
            },
            sse_resume: false,
          }
        : {
            mode: input.config.copilotRuntimeMode,
            accepting_new_work: true,
            active_turn_capacity: {
              enabled: true,
              limit: input.config.maxActiveSessions,
            },
            approval_resolution: {
              supported: true,
              waiter: 'polling',
            },
            sse_resume: false,
          },
      backend: snapshot?.backend
        ? {
            name: snapshot.backend.name,
            capabilities: snakeCaseCapabilities(snapshot.backend.capabilities),
          }
        : null,
      acp: {
        native_cancel: snapshot
          ? {
              classification: snapshot.acp.nativeCancel.classification,
              support: snapshot.acp.nativeCancel.support,
              source: snapshot.acp.nativeCancel.source,
            }
          : {
              classification: 'unknown',
              support: 'unknown',
              source: 'unknown',
            },
      },
      security: {
        bearer_auth: true,
        cors_mode: input.config.corsMode,
        loopback_only: input.config.host === '127.0.0.1' || input.config.host === '::1',
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

function snakeCaseCapabilities(input: object): Record<string, boolean> {
  const output: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'boolean') {
      output[toSnakeCase(key)] = value;
    }
  }
  return output;
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
