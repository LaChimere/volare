import type { IAgentLoomError } from './types';

export class AgentLoomError extends Error implements IAgentLoomError {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'AgentLoomError';
    this.code = code;
    if ('cause' in options) {
      this.cause = options.cause;
    }
  }
}

export function toAgentLoomError(error: unknown): AgentLoomError {
  if (error instanceof AgentLoomError) {
    return error;
  }

  if (error instanceof Error) {
    return new AgentLoomError('internal_error', error.message, { cause: error });
  }

  return new AgentLoomError('internal_error', 'Unexpected non-error failure', { cause: error });
}
