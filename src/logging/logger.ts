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

export interface ILogFields {
  [key: string]: LogValue;
}

export interface ILogBindings {
  [key: string]: LogValue;
}

export interface ILogger {
  child(bindings: ILogBindings): ILogger;
  trace(fields: ILogFields, message?: string): void;
  debug(fields: ILogFields, message?: string): void;
  info(fields: ILogFields, message?: string): void;
  warn(fields: ILogFields, message?: string): void;
  error(fields: ILogFields, message?: string): void;
  fatal(fields: ILogFields, message?: string): void;
}

export interface ICreateLoggerOptions {
  level?: LogLevel;
  bindings?: ILogBindings;
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

export class PinoLogger implements ILogger {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  child(bindings: ILogBindings): ILogger {
    return new PinoLogger(this.#logger.child(bindings));
  }

  trace(fields: ILogFields, message?: string): void {
    writeLog(this.#logger.trace.bind(this.#logger), fields, message);
  }

  debug(fields: ILogFields, message?: string): void {
    writeLog(this.#logger.debug.bind(this.#logger), fields, message);
  }

  info(fields: ILogFields, message?: string): void {
    writeLog(this.#logger.info.bind(this.#logger), fields, message);
  }

  warn(fields: ILogFields, message?: string): void {
    writeLog(this.#logger.warn.bind(this.#logger), fields, message);
  }

  error(fields: ILogFields, message?: string): void {
    writeLog(this.#logger.error.bind(this.#logger), fields, message);
  }

  fatal(fields: ILogFields, message?: string): void {
    writeLog(this.#logger.fatal.bind(this.#logger), fields, message);
  }
}

export class NoopLogger implements ILogger {
  child(): ILogger {
    return this;
  }

  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
}

export function createLogger(options: ICreateLoggerOptions = {}): ILogger {
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
  write: (fields: ILogFields, message?: string) => void,
  fields: ILogFields,
  message?: string,
): void {
  if (message === undefined) {
    write(fields);
    return;
  }
  write(fields, message);
}
