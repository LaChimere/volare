import { VolareError } from '../core/errors';

export interface IRedactionResult {
  value: unknown;
  redactionJson: { redactedPaths: string[] };
}

export interface IRedactor {
  redact(value: unknown): IRedactionResult;
}

export class RedactionFailedError extends VolareError {
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
const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:']);
const URL_MAX_BYTES = 2048;

export class DefaultRedactor implements IRedactor {
  redact(value: unknown): IRedactionResult {
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
  const originalByteCount = new TextEncoder().encode(value).byteLength;
  if (hasAsciiControl(value)) {
    markRedacted(redactedPaths, path);
    return '[redacted-url:invalid-control]';
  }
  if (hasPercentEncodedUserinfo(value)) {
    markRedacted(redactedPaths, path);
    return '[redacted-url:encoded-userinfo]';
  }
  try {
    const url = new URL(value);
    if (!SAFE_URL_PROTOCOLS.has(url.protocol)) {
      markRedacted(redactedPaths, path);
      return `[redacted-url:scheme=${url.protocol.slice(0, -1) || 'unknown'}]`;
    }
    if (url.username || url.password || url.search || url.hash) {
      markRedacted(redactedPaths, path);
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const redactedUrl = url.toString();
    if (new TextEncoder().encode(redactedUrl).byteLength > URL_MAX_BYTES) {
      markRedacted(redactedPaths, path);
      return `[redacted-url:scheme=${url.protocol.slice(0, -1)},host=${url.host},byteCount=${originalByteCount}]`;
    }
    return redactedUrl;
  } catch {
    markRedacted(redactedPaths, path);
    return '[redacted-url]';
  }
}

function markRedacted(redactedPaths: string[], path: string): void {
  if (redactedPaths.at(-1) !== path) {
    redactedPaths.push(path);
  }
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasPercentEncodedUserinfo(value: string): boolean {
  const authority = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/)?.[1] ?? '';
  return /%(?:40|3a)/i.test(authority);
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
    return { redacted: true, charCount: value.length };
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
