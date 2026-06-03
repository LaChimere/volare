import { VolareError } from '../../core/errors';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

interface IJsonRpcRequest {
  [key: string]: JsonValue;
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: JsonObject;
}

export interface IJsonRpcResponse {
  [key: string]: JsonValue;
  jsonrpc: '2.0';
  id: number;
  result?: JsonValue;
  error?: JsonObject;
}

export interface IAcpWritable {
  write(chunk: Uint8Array): unknown | Promise<unknown>;
  flush?(): unknown | Promise<unknown>;
  end?(): void;
}

export type AcpPermissionPolicy = 'allow' | 'deny' | 'cancelled' | 'unsupported';

export interface IAcpJsonRpcPeerOptions {
  stdin: IAcpWritable;
  stdout: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  requestTimeoutMs: number;
  supportedProtocolVersions?: readonly number[];
  permissionPolicy?: AcpPermissionPolicy;
  onNotification?: (frame: JsonObject) => void;
}

export interface IAcpInitializeSummary {
  protocolVersion: number;
  agentCapabilities: JsonValue;
  agentInfo: JsonValue;
  authMethods: JsonValue;
}

export interface IAcpSessionSummary {
  sessionId: string;
}

interface IPendingRequest {
  method: string;
  resolve(response: IJsonRpcResponse): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

const textEncoder = new TextEncoder();
const SUPPORTED_ACP_PROTOCOL_VERSIONS = [1] as const;

export class AcpProtocolError extends VolareError {
  constructor(code: string, message: string, cause?: unknown) {
    super(code, message, cause === undefined ? {} : { cause });
    this.name = 'AcpProtocolError';
  }
}

export class AcpJsonRpcPeer {
  readonly #stdin: IAcpWritable;
  readonly #requestTimeoutMs: number;
  readonly #supportedProtocolVersions: readonly number[];
  readonly #permissionPolicy: AcpPermissionPolicy;
  readonly #onNotification: ((frame: JsonObject) => void) | undefined;
  readonly #pending = new Map<number, IPendingRequest>();
  readonly #diagnostics: string[] = [];
  #stdoutReader: { cancel(reason?: unknown): Promise<void> } | undefined;
  #stderrReader: { cancel(reason?: unknown): Promise<void> } | undefined;
  #nextId = 1;
  #closed = false;
  #stdoutTask: Promise<void>;
  #stderrTask: Promise<void>;

  constructor(options: IAcpJsonRpcPeerOptions) {
    this.#stdin = options.stdin;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#supportedProtocolVersions =
      options.supportedProtocolVersions ?? SUPPORTED_ACP_PROTOCOL_VERSIONS;
    this.#permissionPolicy = options.permissionPolicy ?? 'unsupported';
    this.#onNotification = options.onNotification;
    this.#stdoutTask = this.#readStdout(options.stdout);
    this.#stderrTask = this.#readStderr(options.stderr ?? null);
  }

  get diagnostics(): string {
    return this.#diagnostics.join('\n');
  }

  async initialize(): Promise<IAcpInitializeSummary> {
    const response = await this.request('initialize', {
      protocolVersion: this.#supportedProtocolVersions[0] ?? 1,
      clientInfo: {
        name: 'volare',
        version: '0.0.0',
      },
      clientCapabilities: {},
    });
    return parseAcpInitializeResponse(response.result, this.#supportedProtocolVersions);
  }

  async request(method: string, params?: JsonObject): Promise<IJsonRpcResponse> {
    if (this.#closed) {
      throw new AcpProtocolError('acp_peer_closed', 'ACP peer is closed');
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const frame: IJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const response = new Promise<IJsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AcpProtocolError('acp_request_timeout', `ACP request timed out: ${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timeout });
    });
    try {
      await this.#writeFrame(frame);
    } catch (cause) {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
      }
      throw cause;
    }
    return await response;
  }

  async notify(method: string, params?: JsonObject): Promise<void> {
    if (this.#closed) {
      throw new AcpProtocolError('acp_peer_closed', 'ACP peer is closed');
    }
    await this.#writeFrame({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stdin.end?.();
    this.#rejectPending(new AcpProtocolError('acp_peer_closed', 'ACP peer is closed'));
    void this.#stdoutReader?.cancel();
    void this.#stderrReader?.cancel();
  }

  async waitForReaders(): Promise<void> {
    await Promise.allSettled([this.#stdoutTask, this.#stderrTask]);
  }

  async #writeFrame(frame: unknown): Promise<void> {
    await this.#stdin.write(textEncoder.encode(`${JSON.stringify(frame)}\n`));
    await this.#stdin.flush?.();
  }

  async #readStdout(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) {
      return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    this.#stdoutReader = reader;
    let buffer = '';
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        buffer = this.#consumeLines(buffer);
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        this.#consumeLine(buffer);
      }
      if (!this.#closed && this.#pending.size > 0) {
        this.#rejectPending(
          new AcpProtocolError('acp_stdout_closed', 'ACP stdout closed with pending requests'),
        );
      }
    } catch (cause) {
      this.#rejectPending(new AcpProtocolError('acp_stdout_failed', 'ACP stdout failed', cause));
    } finally {
      this.#stdoutReader = undefined;
      reader.releaseLock();
    }
  }

  async #readStderr(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) {
      return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    this.#stderrReader = reader;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        this.#diagnostics.push(decoder.decode(result.value, { stream: true }));
      }
    } finally {
      this.#stderrReader = undefined;
      reader.releaseLock();
    }
  }

  #consumeLines(buffer: string): string {
    let nextNewline = buffer.indexOf('\n');
    while (nextNewline >= 0) {
      this.#consumeLine(buffer.slice(0, nextNewline));
      buffer = buffer.slice(nextNewline + 1);
      nextNewline = buffer.indexOf('\n');
    }
    return buffer;
  }

  #consumeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let frame: JsonValue;
    try {
      frame = JSON.parse(trimmed) as JsonValue;
    } catch (cause) {
      this.#rejectPending(
        new AcpProtocolError('acp_invalid_json', 'ACP stdout is not JSON', cause),
      );
      return;
    }

    if (isJsonRpcResponse(frame)) {
      const pending = this.#pending.get(frame.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(frame.id);
      clearTimeout(pending.timeout);
      if (frame.error) {
        pending.reject(jsonRpcResponseError(pending.method, frame.error));
        return;
      }
      pending.resolve(frame);
      return;
    }

    if (isJsonRpcRequest(frame)) {
      void this.#writeFrame(this.#reverseRequestResponse(frame)).catch((cause) => {
        this.#diagnostics.push(`reverse callback response failed: ${errorMessage(cause)}`);
      });
      return;
    }

    if (isJsonObject(frame) && getField(frame, 'method') !== undefined) {
      this.#onNotification?.(frame);
    }
  }

  #reverseRequestResponse(request: IJsonRpcRequest): IJsonRpcResponse {
    if (request.method !== 'session/request_permission') {
      return unsupportedCallbackResponse(request);
    }
    return permissionResponseFrame(request, this.#permissionPolicy);
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

export function parseAcpInitializeResponse(
  result: JsonValue | undefined,
  supportedProtocolVersions: readonly number[] = SUPPORTED_ACP_PROTOCOL_VERSIONS,
): IAcpInitializeSummary {
  if (!isJsonObject(result)) {
    throw new AcpProtocolError('acp_initialize_invalid', 'ACP initialize result must be an object');
  }
  const protocolVersion = getField(result, 'protocolVersion');
  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) {
    throw new AcpProtocolError(
      'acp_protocol_version_invalid',
      'ACP initialize protocolVersion must be an integer',
    );
  }
  if (!supportedProtocolVersions.includes(protocolVersion)) {
    throw new AcpProtocolError(
      'acp_protocol_version_unsupported',
      `ACP protocolVersion is unsupported: ${protocolVersion}`,
    );
  }
  return {
    protocolVersion,
    agentCapabilities: getField(result, 'agentCapabilities') ?? {},
    agentInfo: getField(result, 'agentInfo') ?? null,
    authMethods: getField(result, 'authMethods') ?? [],
  };
}

export function parseAcpSessionNewResponse(result: JsonValue | undefined): IAcpSessionSummary {
  if (!isJsonObject(result)) {
    throw new AcpProtocolError(
      'acp_session_new_invalid',
      'ACP session/new result must be an object',
    );
  }
  const sessionId = getField(result, 'sessionId');
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new AcpProtocolError(
      'acp_session_id_missing',
      'ACP session/new result must include sessionId',
    );
  }
  return { sessionId };
}

function permissionResponseFrame(
  request: IJsonRpcRequest,
  policy: AcpPermissionPolicy,
): IJsonRpcResponse {
  if (policy === 'unsupported') {
    return unsupportedCallbackResponse(request);
  }
  if (policy === 'cancelled') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { outcome: { outcome: 'cancelled' } },
    };
  }
  const optionId = selectPermissionOption(request.params, policy);
  if (!optionId) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32602, message: `No ${policy} permission option was available` },
    };
  }
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: { outcome: { outcome: 'selected', optionId } },
  };
}

function jsonRpcResponseError(method: string, error: JsonObject): AcpProtocolError {
  const code = getField(error, 'code');
  const message = getField(error, 'message');
  return new AcpProtocolError(
    'acp_response_error',
    `ACP ${method} failed: ${typeof message === 'string' ? message : 'JSON-RPC error'}`,
    {
      jsonRpcCode: typeof code === 'number' ? code : null,
      error,
    },
  );
}

function unsupportedCallbackResponse(request: IJsonRpcRequest): IJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: `Unsupported ACP client callback: ${request.method}` },
  };
}

function selectPermissionOption(
  params: JsonObject | undefined,
  policy: Extract<AcpPermissionPolicy, 'allow' | 'deny'>,
): string | null {
  const options = params ? getField(params, 'options') : undefined;
  if (!Array.isArray(options)) {
    return null;
  }
  const preferredKinds =
    policy === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const preferredKind of preferredKinds) {
    const option = options.find((candidate) => {
      if (!isJsonObject(candidate)) {
        return false;
      }
      return (
        getField(candidate, 'kind') === preferredKind &&
        typeof getField(candidate, 'optionId') === 'string'
      );
    });
    if (isJsonObject(option)) {
      const optionId = getField(option, 'optionId');
      return typeof optionId === 'string' ? optionId : null;
    }
  }
  return null;
}

function isJsonRpcResponse(value: JsonValue): value is IJsonRpcResponse {
  if (!isJsonObject(value)) {
    return false;
  }
  const jsonrpc = getField(value, 'jsonrpc');
  const id = getField(value, 'id');
  const method = getField(value, 'method');
  return jsonrpc === '2.0' && Number.isInteger(id) && method === undefined;
}

function isJsonRpcRequest(value: JsonValue): value is IJsonRpcRequest {
  if (!isJsonObject(value)) {
    return false;
  }
  const jsonrpc = getField(value, 'jsonrpc');
  const id = getField(value, 'id');
  const method = getField(value, 'method');
  return jsonrpc === '2.0' && Number.isInteger(id) && typeof method === 'string';
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getField(object: JsonObject, key: string): JsonValue | undefined {
  return object[key];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
