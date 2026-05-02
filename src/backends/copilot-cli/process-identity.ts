import { AgentLoomError } from '../../core/errors';

export interface ProcessIdentityInterface {
  processId: string;
  processStartedAt: number;
  processIdentityHash: string;
}

export interface ProcessIdentityValidatorInterface {
  assertMatches(expected: ProcessIdentityInterface, observedProcessId: string): void;
}

export class DefaultProcessIdentityValidator implements ProcessIdentityValidatorInterface {
  assertMatches(expected: ProcessIdentityInterface, observedProcessId: string): void {
    const observedHash = createProcessIdentityHash(expected.processId, expected.processStartedAt);
    if (expected.processId !== observedProcessId || expected.processIdentityHash !== observedHash) {
      throw new AgentLoomError('process_identity_mismatch', 'Process identity did not match');
    }
  }
}

export function createProcessIdentity(
  processId: string,
  processStartedAt: number,
): ProcessIdentityInterface {
  return {
    processId,
    processStartedAt,
    processIdentityHash: createProcessIdentityHash(processId, processStartedAt),
  };
}

export function createProcessIdentityHash(processId: string, processStartedAt: number): string {
  return `process:${processId}:${processStartedAt}`;
}
