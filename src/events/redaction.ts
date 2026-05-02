import { AgentLoomError } from '../core/errors';

export interface RedactionResultInterface {
  value: unknown;
  redactionJson: { redactedPaths: string[] };
}

export interface RedactorInterface {
  redact(value: unknown): RedactionResultInterface;
}

export class RedactionFailedError extends AgentLoomError {
  constructor(stage: string, cause: unknown) {
    super('redaction_failed', 'Redaction failed before journal persistence', {
      cause: { stage, cause },
    });
    this.name = 'RedactionFailedError';
  }
}

const SAFE_HEADER_NAMES = new Set(['accept', 'content-length', 'content-type']);
const SAFE_ENV_NAMES = new Set(['CI', 'NODE_ENV']);
const SECRET_KEY_PATTERN = /authorization|cookie|token|api[_-]?key|password|secret/i;

export class DefaultRedactor implements RedactorInterface {
  redact(value: unknown): RedactionResultInterface {
    const redactedPaths: string[] = [];
    try {
      return {
        value: redactValue(value, '$', redactedPaths),
        redactionJson: { redactedPaths },
      };
    } catch (cause) {
      throw new RedactionFailedError('default', cause);
    }
  }
}

function redactValue(value: unknown, path: string, redactedPaths: string[]): unknown {
  if (value instanceof Headers) {
    return redactHeaders(Object.fromEntries(value.entries()), path, redactedPaths);
  }
  if (value instanceof Uint8Array) {
    redactedPaths.push(path);
    return { redacted: true, byteCount: value.byteLength };
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, `${path}[${index}]`, redactedPaths));
  }
  if (!isRecord(value)) {
    return value;
  }

  if (value['action'] === 'shell:exec' && isRecord(value['scope'])) {
    return redactShellPermission(value, path, redactedPaths);
  }

  return redactObjectFields(value, path, redactedPaths);
}

function redactObjectFields(
  value: Record<string, unknown>,
  path: string,
  redactedPaths: string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = redactScalar(child, childPath, redactedPaths);
    } else if (key === 'headers' && isRecord(child)) {
      output[key] = redactHeaders(child, childPath, redactedPaths);
    } else if ((key === 'env' || key === 'environment') && isRecord(child)) {
      output[key] = redactEnvironment(child, childPath, redactedPaths);
    } else if (key === 'command' && typeof child === 'string') {
      output[key] = summarizeCommand(child, childPath, redactedPaths);
    } else if ((key === 'url' || key === 'uri') && typeof child === 'string') {
      output[key] = redactUrl(child, childPath, redactedPaths);
    } else if (isPromptLikeKey(key) && typeof child === 'string') {
      output[key] = summarizeString(child, childPath, redactedPaths);
    } else if (
      isFileContentKey(key) &&
      (typeof child === 'string' || child instanceof Uint8Array)
    ) {
      output[key] = summarizeBytes(child, childPath, redactedPaths);
    } else {
      output[key] = redactValue(child, childPath, redactedPaths);
    }
  }
  return output;
}

function redactShellPermission(
  value: Record<string, unknown>,
  path: string,
  redactedPaths: string[],
): Record<string, unknown> {
  const scope = isRecord(value['scope']) ? { ...value['scope'] } : {};
  if (typeof scope['command'] === 'string') {
    scope['command'] = summarizeCommand(scope['command'], `${path}.scope.command`, redactedPaths);
  }
  return redactObjectFields({ ...value, scope }, path, redactedPaths);
}

function redactHeaders(
  headers: Record<string, unknown>,
  path: string,
  redactedPaths: string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (SAFE_HEADER_NAMES.has(normalized)) {
      output[key] = value;
    } else {
      output[key] = redactScalar(value, `${path}.${key}`, redactedPaths);
    }
  }
  return output;
}

function redactEnvironment(
  environment: Record<string, unknown>,
  path: string,
  redactedPaths: string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (SAFE_ENV_NAMES.has(key)) {
      output[key] = value;
    } else {
      output[key] = redactScalar(value, `${path}.${key}`, redactedPaths);
    }
  }
  return output;
}

function redactUrl(value: string, path: string, redactedPaths: string[]): string {
  try {
    const url = new URL(value);
    if (url.search || url.hash) {
      redactedPaths.push(path);
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    redactedPaths.push(path);
    return '[redacted-url]';
  }
}

function summarizeCommand(command: string, path: string, redactedPaths: string[]) {
  redactedPaths.push(path);
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return {
    redacted: true,
    commandName: parts[0] ?? '',
    argumentCount: Math.max(parts.length - 1, 0),
  };
}

function summarizeString(value: string, path: string, redactedPaths: string[]) {
  redactedPaths.push(path);
  return { redacted: true, charCount: value.length };
}

function summarizeBytes(value: string | Uint8Array, path: string, redactedPaths: string[]) {
  redactedPaths.push(path);
  return {
    redacted: true,
    byteCount:
      typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength,
  };
}

function redactScalar(value: unknown, path: string, redactedPaths: string[]) {
  redactedPaths.push(path);
  if (typeof value === 'string') {
    return summarizeString(value, path, []);
  }
  return '[redacted]';
}

function isPromptLikeKey(key: string): boolean {
  return key === 'prompt' || key === 'message' || key === 'input' || key === 'reason';
}

function isFileContentKey(key: string): boolean {
  return key === 'content' || key === 'data' || key === 'fileContents' || key === 'attachment';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
