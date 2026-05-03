import pino, { type DestinationStream, type Logger } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | LogValue[]
  | { [key: string]: LogValue };

export interface LogFieldsInterface {
  [key: string]: LogValue;
}

export interface LogBindingsInterface {
  [key: string]: LogValue;
}

export interface LoggerInterface {
  child(bindings: LogBindingsInterface): LoggerInterface;
  trace(fields: LogFieldsInterface, message?: string): void;
  debug(fields: LogFieldsInterface, message?: string): void;
  info(fields: LogFieldsInterface, message?: string): void;
  warn(fields: LogFieldsInterface, message?: string): void;
  error(fields: LogFieldsInterface, message?: string): void;
  fatal(fields: LogFieldsInterface, message?: string): void;
}

export interface CreateLoggerOptionsInterface {
  level?: LogLevel;
  bindings?: LogBindingsInterface;
  destination?: DestinationStream;
}

const redactionPaths = [
  'apiKey',
  'authorization',
  'token',
  'githubToken',
  'headers.authorization',
  'headers.Authorization',
  'request.headers.authorization',
  'request.headers.Authorization',
  'env',
  'prompt',
  'input',
  'body',
  'content',
  'fileContents',
  'command',
] as const;

export class PinoLogger implements LoggerInterface {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  child(bindings: LogBindingsInterface): LoggerInterface {
    return new PinoLogger(this.#logger.child(bindings));
  }

  trace(fields: LogFieldsInterface, message?: string): void {
    writeLog(this.#logger.trace.bind(this.#logger), fields, message);
  }

  debug(fields: LogFieldsInterface, message?: string): void {
    writeLog(this.#logger.debug.bind(this.#logger), fields, message);
  }

  info(fields: LogFieldsInterface, message?: string): void {
    writeLog(this.#logger.info.bind(this.#logger), fields, message);
  }

  warn(fields: LogFieldsInterface, message?: string): void {
    writeLog(this.#logger.warn.bind(this.#logger), fields, message);
  }

  error(fields: LogFieldsInterface, message?: string): void {
    writeLog(this.#logger.error.bind(this.#logger), fields, message);
  }

  fatal(fields: LogFieldsInterface, message?: string): void {
    writeLog(this.#logger.fatal.bind(this.#logger), fields, message);
  }
}

export class NoopLogger implements LoggerInterface {
  child(): LoggerInterface {
    return this;
  }

  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
}

export function createLogger(options: CreateLoggerOptionsInterface = {}): LoggerInterface {
  const logger = pino(
    {
      level: options.level ?? 'info',
      base: {
        service: 'agent-loom',
        ...(options.bindings ?? {}),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      serializers: {
        error: pino.stdSerializers.err,
        err: pino.stdSerializers.err,
      },
      redact: {
        paths: [...redactionPaths],
        censor: '[Redacted]',
      },
    },
    options.destination,
  );
  return new PinoLogger(logger);
}

function writeLog(
  write: (fields: LogFieldsInterface, message?: string) => void,
  fields: LogFieldsInterface,
  message?: string,
): void {
  if (message === undefined) {
    write(fields);
    return;
  }
  write(fields, message);
}
