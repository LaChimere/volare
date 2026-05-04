import type { IVolareError } from './types';

export class VolareError extends Error implements IVolareError {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'VolareError';
    this.code = code;
    if ('cause' in options) {
      this.cause = options.cause;
    }
  }
}

export function toVolareError(error: unknown): VolareError {
  if (error instanceof VolareError) {
    return error;
  }

  if (error instanceof Error) {
    return new VolareError('internal_error', error.message, { cause: error });
  }

  return new VolareError('internal_error', 'Unexpected non-error failure', { cause: error });
}
