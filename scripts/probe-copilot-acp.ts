import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ProbeStatus = 'supported' | 'unsupported' | 'unknown' | 'skipped' | 'failed';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface IJsonRpcRequest {
  [key: string]: JsonValue;
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: JsonObject;
}

interface IJsonRpcResponse {
  [key: string]: JsonValue;
  jsonrpc: '2.0';
  id: number;
  result?: JsonValue;
  error?: JsonObject;
}

interface IAcpWritable {
  write(chunk: Uint8Array): unknown | Promise<unknown>;
  flush?(): unknown | Promise<unknown>;
  end?(): void;
}

export interface IAcpPeerOptions {
  stdin: IAcpWritable;
  stdout: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  requestTimeoutMs?: number;
  maxDiagnosticBytes?: number;
  supportedProtocolVersions?: readonly number[];
  reverseRequestPolicy?: Partial<Record<string, AcpReverseRequestPolicy>>;
}

export interface IAcpInitializeSummary {
  protocolVersion: number;
  agentCapabilities: JsonValue;
  agentInfo: JsonValue;
  authMethods: JsonValue;
}

export interface IAcpProbeResult {
  name: string;
  status: ProbeStatus;
  evidence: string;
}

export interface IAcpProbeReport {
  generatedAt: string;
  copilotPath: string | null;
  copilotVersion: string | null;
  results: IAcpProbeResult[];
}

export type AcpReverseRequestPolicy = 'unsupported' | 'allow' | 'deny' | 'cancelled';

export interface IAcpReverseRequestRecord {
  method: string;
  policy: AcpReverseRequestPolicy;
}

interface IAcpDiscoveryEvidence {
  protocolVersion: number;
  unsupportedProtocolVersion: JsonValue;
  agentCapabilities: JsonValue;
  authMethods: JsonValue;
  sessionNew: {
    resultShape: JsonValue;
    sessionIdBytes: number;
  };
  prompt: {
    terminalResponse: string;
    stopReasons: string[];
    updateMethods: string[];
    updateKinds: string[];
    callbackMethods: string[];
    messageCount: number;
  };
  bindingMatrix: {
    cwd: string;
    model: string;
    permissionMode: string;
    mcpMode: string;
    noCustomInstructions: string;
  };
  timingsMs: {
    initialize: number;
    sessionNew: number;
    prompt: number;
  };
}

interface IPendingRequest {
  method: string;
  resolve(response: IJsonRpcResponse): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 16_384;
const DEFAULT_SUPPORTED_ACP_PROTOCOL_VERSIONS = [1] as const;
const SAFE_SYNTHETIC_PROMPT = 'Reply with the single word OK.';

export class AcpProbeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AcpProbeError';
  }
}

export class AcpJsonRpcPeer {
  readonly #stdin: IAcpWritable;
  readonly #requestTimeoutMs: number;
  readonly #supportedProtocolVersions: readonly number[];
  readonly #reverseRequestPolicy: Partial<Record<string, AcpReverseRequestPolicy>>;
  readonly #pending = new Map<number, IPendingRequest>();
  readonly #messages: JsonValue[] = [];
  readonly #serverRequestRecords: IAcpReverseRequestRecord[] = [];
  readonly #diagnostics: string[] = [];
  readonly #maxDiagnosticBytes: number;
  #stdoutReader: { cancel(reason?: unknown): Promise<void> } | undefined;
  #stderrReader: { cancel(reason?: unknown): Promise<void> } | undefined;
  #nextId = 1;
  #closed = false;
  #stdoutTask: Promise<void>;
  #stderrTask: Promise<void>;

  constructor(options: IAcpPeerOptions) {
    this.#stdin = options.stdin;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#supportedProtocolVersions =
      options.supportedProtocolVersions ?? DEFAULT_SUPPORTED_ACP_PROTOCOL_VERSIONS;
    this.#reverseRequestPolicy = options.reverseRequestPolicy ?? {};
    this.#maxDiagnosticBytes = options.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
    this.#stdoutTask = this.#readStdout(options.stdout);
    this.#stderrTask = this.#readStderr(options.stderr ?? null);
  }

  get diagnostics(): string {
    return this.#diagnostics.join('\n');
  }

  get messages(): readonly JsonValue[] {
    return this.#messages;
  }

  get serverRequestMethods(): readonly string[] {
    return [...new Set(this.#serverRequestRecords.map((record) => record.method))].sort();
  }

  get serverRequestRecords(): readonly IAcpReverseRequestRecord[] {
    return this.#serverRequestRecords;
  }

  async initialize(): Promise<IAcpInitializeSummary> {
    const response = await this.request('initialize', {
      protocolVersion: this.#supportedProtocolVersions[0] ?? 1,
      clientInfo: {
        name: 'volare-acp-probe',
        version: '0.0.0',
      },
      clientCapabilities: {},
    });
    return summarizeInitializeResponse(response.result, this.#supportedProtocolVersions);
  }

  async request(method: string, params?: JsonObject): Promise<IJsonRpcResponse> {
    if (this.#closed) {
      throw new AcpProbeError('ACP peer is closed', 'peer_closed');
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const request: IJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    const responsePromise = new Promise<IJsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AcpProbeError(`ACP request timed out: ${method}`, 'request_timeout'));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timeout });
    });

    await this.#writeFrame(request);
    return await responsePromise;
  }

  async notify(method: string, params?: JsonObject): Promise<void> {
    if (this.#closed) {
      throw new AcpProbeError('ACP peer is closed', 'peer_closed');
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
    this.#rejectPending(new AcpProbeError('ACP peer closed', 'peer_closed'));
    void this.#stdoutReader?.cancel();
    void this.#stderrReader?.cancel();
  }

  async waitForReaders(): Promise<void> {
    await Promise.allSettled([this.#stdoutTask, this.#stderrTask]);
  }

  async #writeFrame(frame: unknown): Promise<void> {
    const line = `${JSON.stringify(frame)}\n`;
    await this.#stdin.write(textEncoder.encode(line));
    await this.#stdin.flush?.();
  }

  async #readStdout(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) {
      return;
    }

    const reader = stream.getReader();
    this.#stdoutReader = reader;
    let buffer = '';
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        buffer += textDecoder.decode(result.value, { stream: true });
        buffer = this.#consumeLines(buffer);
      }
      buffer += textDecoder.decode();
      this.#consumeFinalLine(buffer);
      if (!this.#closed && this.#pending.size > 0) {
        this.#rejectPending(
          new AcpProbeError('ACP stdout closed with pending requests', 'stdout_closed'),
        );
      }
    } catch (cause) {
      this.#rejectPending(toAcpError(cause, 'stdout_read_failed'));
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
    this.#stderrReader = reader;
    let capturedBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        if (capturedBytes >= this.#maxDiagnosticBytes) {
          continue;
        }
        const remaining = this.#maxDiagnosticBytes - capturedBytes;
        const chunk =
          result.value.byteLength > remaining ? result.value.slice(0, remaining) : result.value;
        capturedBytes += chunk.byteLength;
        this.#diagnostics.push(redactDiagnosticText(textDecoder.decode(chunk, { stream: true })));
      }
    } finally {
      this.#stderrReader = undefined;
      reader.releaseLock();
    }
  }

  #consumeLines(buffer: string): string {
    let nextNewline = buffer.indexOf('\n');
    while (nextNewline >= 0) {
      const line = buffer.slice(0, nextNewline);
      this.#consumeLine(line);
      buffer = buffer.slice(nextNewline + 1);
      nextNewline = buffer.indexOf('\n');
    }
    return buffer;
  }

  #consumeFinalLine(buffer: string): void {
    if (buffer.trim().length > 0) {
      this.#consumeLine(buffer);
    }
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
      this.#rejectPending(toAcpError(cause, 'invalid_json'));
      return;
    }

    this.#messages.push(redactAcpFrame(frame));
    if (!isJsonRpcResponse(frame)) {
      if (isJsonRpcRequest(frame)) {
        const decision = this.#reverseRequestDecision(frame);
        this.#serverRequestRecords.push({ method: frame.method, policy: decision.policy });
        void this.#writeFrame(decision.frame).catch((cause) => {
          this.#diagnostics.push(redactDiagnosticText(toAcpError(cause, 'callback_error').message));
        });
      }
      return;
    }

    const pending = this.#pending.get(frame.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(frame.id);
    clearTimeout(pending.timeout);
    pending.resolve(frame);
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  #reverseRequestDecision(request: IJsonRpcRequest): {
    policy: AcpReverseRequestPolicy;
    frame: IJsonRpcResponse;
  } {
    const configuredPolicy = this.#reverseRequestPolicy[request.method] ?? 'unsupported';
    if (request.method === 'session/request_permission') {
      return {
        policy: configuredPolicy,
        frame: permissionResponseFrame(request, configuredPolicy),
      };
    }

    return {
      policy: 'unsupported',
      frame: unsupportedCallbackResponse(request),
    };
  }
}

export function summarizeInitializeResponse(
  result: JsonValue | undefined,
  supportedProtocolVersions: readonly number[] = DEFAULT_SUPPORTED_ACP_PROTOCOL_VERSIONS,
): IAcpInitializeSummary {
  if (!isJsonObject(result)) {
    throw new AcpProbeError(
      'ACP initialize response is missing result object',
      'invalid_initialize',
    );
  }

  const protocolVersion = getField(result, 'protocolVersion');
  if (protocolVersion === undefined) {
    throw new AcpProbeError(
      'ACP initialize response is missing protocolVersion',
      'missing_protocol_version',
    );
  }
  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) {
    throw new AcpProbeError(
      'ACP initialize response protocolVersion is not an integer',
      'non_integer_protocol_version',
    );
  }
  if (!supportedProtocolVersions.includes(protocolVersion)) {
    throw new AcpProbeError(
      `ACP initialize response protocolVersion is unsupported: ${protocolVersion}`,
      'unsupported_protocol_version',
    );
  }

  return {
    protocolVersion,
    agentCapabilities: getField(result, 'agentCapabilities') ?? {},
    agentInfo: getField(result, 'agentInfo') ?? null,
    authMethods: getField(result, 'authMethods') ?? [],
  };
}

export function redactAcpFrame(frame: unknown): JsonValue {
  return redactValue(frame, []);
}

export async function runSelfTests(): Promise<IAcpProbeResult[]> {
  const results: IAcpProbeResult[] = [];
  const cases: Array<{ name: string; run(): Promise<void> }> = [
    {
      name: 'valid initialize',
      async run() {
        await withScriptedPeer(
          [
            {
              jsonrpc: '2.0',
              id: 1,
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: false },
                agentInfo: { name: 'fake-acp' },
                authMethods: [],
              },
            },
          ],
          async (peer) => {
            const summary = await peer.initialize();
            if (summary.protocolVersion !== 1) {
              throw new Error('expected protocolVersion 1');
            }
          },
        );
      },
    },
    {
      name: 'malformed JSON',
      async run() {
        await withScriptedPeer(['{"jsonrpc":"2.0",'], async (peer) => {
          await expectRejects(peer.initialize(), 'invalid_json');
        });
      },
    },
    {
      name: 'missing protocolVersion',
      async run() {
        await assertInitializeResultFails({}, 'missing_protocol_version');
      },
    },
    {
      name: 'non-integer protocolVersion',
      async run() {
        await assertInitializeResultFails({ protocolVersion: '1' }, 'non_integer_protocol_version');
      },
    },
    {
      name: 'unsupported protocolVersion',
      async run() {
        await assertInitializeResultFails({ protocolVersion: 999 }, 'unsupported_protocol_version');
      },
    },
    {
      name: 'stderr capture',
      async run() {
        const largeDiagnostic = `token=ghp_secretvalue ${'x'.repeat(70_000)}`;
        await withScriptedPeer(
          [{ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }],
          async (peer) => {
            await peer.initialize();
            if (!peer.diagnostics.includes('<REDACTED:token>')) {
              throw new Error('expected diagnostic token redaction');
            }
            if (peer.diagnostics.length > DEFAULT_MAX_DIAGNOSTIC_BYTES + 1024) {
              throw new Error('expected bounded diagnostic capture');
            }
          },
          { stderrLines: [largeDiagnostic] },
        );
      },
    },
    {
      name: 'timeout',
      async run() {
        await withScriptedPeer(
          [],
          async (peer) => {
            await expectRejects(peer.initialize(), 'request_timeout');
          },
          { keepStdoutOpen: true },
        );
      },
    },
  ];

  for (const testCase of cases) {
    try {
      await testCase.run();
      results.push({ name: testCase.name, status: 'supported', evidence: 'passed' });
    } catch (cause) {
      results.push({
        name: testCase.name,
        status: 'failed',
        evidence: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return results;
}

async function probeInitialize(copilotPath: string): Promise<IAcpProbeResult> {
  const proc = Bun.spawn(
    [copilotPath, '--acp', '--no-color', '--no-custom-instructions', '--log-level', 'error'],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...Bun.env,
        NO_COLOR: '1',
        CI: '1',
      },
    },
  );
  const peer = new AcpJsonRpcPeer({
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  try {
    const summary = await peer.initialize();
    return {
      name: 'ACP initialize handshake',
      status: 'supported',
      evidence: JSON.stringify(redactAcpFrame(summary)),
    };
  } catch (cause) {
    return {
      name: 'ACP initialize handshake',
      status: 'unknown',
      evidence: `${cause instanceof Error ? cause.message : String(cause)}; stderr=${peer.diagnostics}`,
    };
  } finally {
    peer.close();
    proc.kill('SIGTERM');
    await Promise.race([proc.exited, Bun.sleep(1_000)]);
    proc.kill('SIGKILL');
  }
}

async function probeDiscovery(copilotPath: string): Promise<IAcpProbeResult[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'volare-acp-discovery-'));
  const proc = Bun.spawn(
    [
      copilotPath,
      '--acp',
      '--no-color',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--log-level',
      'error',
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...Bun.env,
        NO_COLOR: '1',
        CI: '1',
      },
    },
  );
  const peer = new AcpJsonRpcPeer({
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    requestTimeoutMs: 60_000,
  });

  try {
    const initializeStartedAt = performance.now();
    const initializeSummary = await peer.initialize();
    const initializeMs = elapsedMs(initializeStartedAt);
    const unsupportedProtocolVersion = await probeUnsupportedProtocolVersion(copilotPath);

    const sessionStartedAt = performance.now();
    const sessionResponse = await peer.request('session/new', {
      cwd,
      mcpServers: [],
    });
    const sessionNewMs = elapsedMs(sessionStartedAt);
    const sessionId = extractSessionId(sessionResponse.result);

    const promptStartedAt = performance.now();
    const beforePromptMessages = peer.messages.length;
    const promptResponse = await peer.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: SAFE_SYNTHETIC_PROMPT }],
    });
    const promptMs = elapsedMs(promptStartedAt);
    const promptMessages = peer.messages.slice(beforePromptMessages);
    const evidence: IAcpDiscoveryEvidence = {
      protocolVersion: initializeSummary.protocolVersion,
      unsupportedProtocolVersion,
      agentCapabilities: redactAcpFrame(initializeSummary.agentCapabilities),
      authMethods: redactAcpFrame(initializeSummary.authMethods),
      sessionNew: {
        resultShape: redactSessionNewResult(sessionResponse.result),
        sessionIdBytes: textEncoder.encode(sessionId).byteLength,
      },
      prompt: summarizePromptEvidence(promptResponse, promptMessages, peer.serverRequestMethods),
      bindingMatrix: {
        cwd: 'session/new.cwd',
        model: hasConfigOption(sessionResponse.result, 'model')
          ? 'session/new configOptions.id=model'
          : 'not observed in initialize/session/new/session/prompt discovery',
        permissionMode: hasConfigOption(sessionResponse.result, 'allow_all')
          ? 'session/new configOptions.id=allow_all'
          : 'worker startup flags; ACP config method not observed',
        mcpMode: 'session/new.mcpServers=[] with --disable-builtin-mcps',
        noCustomInstructions: 'worker startup flag --no-custom-instructions',
      },
      timingsMs: {
        initialize: initializeMs,
        sessionNew: sessionNewMs,
        prompt: promptMs,
      },
    };

    return [
      {
        name: 'ACP discovery',
        status: 'supported',
        evidence: JSON.stringify(evidence),
      },
    ];
  } catch (cause) {
    return [
      {
        name: 'ACP discovery',
        status: 'failed',
        evidence: `${cause instanceof Error ? cause.message : String(cause)}; stderr=${peer.diagnostics}`,
      },
    ];
  } finally {
    peer.close();
    proc.kill('SIGTERM');
    await Promise.race([proc.exited, Bun.sleep(1_000)]);
    proc.kill('SIGKILL');
    await rm(cwd, { recursive: true, force: true });
  }
}

async function probeUnsupportedProtocolVersion(copilotPath: string): Promise<JsonValue> {
  const proc = Bun.spawn(
    [copilotPath, '--acp', '--no-color', '--no-custom-instructions', '--log-level', 'error'],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...Bun.env,
        NO_COLOR: '1',
        CI: '1',
      },
    },
  );
  const peer = new AcpJsonRpcPeer({
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    requestTimeoutMs: 15_000,
  });
  try {
    const response = await peer.request('initialize', {
      protocolVersion: 999,
      clientInfo: {
        name: 'volare-acp-probe',
        version: '0.0.0',
      },
      clientCapabilities: {},
    });
    return classifyUnsupportedProtocolResponse(response);
  } catch (cause) {
    return {
      requestedProtocolVersion: 999,
      outcome: 'probe_failed',
      message: cause instanceof Error ? cause.message : String(cause),
      messages: [...peer.messages],
      stderr: peer.diagnostics,
    };
  } finally {
    peer.close();
    proc.kill('SIGTERM');
    await Promise.race([proc.exited, Bun.sleep(1_000)]);
    proc.kill('SIGKILL');
  }
}

export function classifyUnsupportedProtocolResponse(response: IJsonRpcResponse): JsonValue {
  if (response.error) {
    return {
      requestedProtocolVersion: 999,
      outcome: 'rejected_with_error',
      error: redactAcpFrame(response.error),
    };
  }
  if (!isJsonObject(response.result)) {
    return {
      requestedProtocolVersion: 999,
      outcome: 'invalid_response_shape',
      response: redactAcpFrame(response),
    };
  }
  const protocolVersion = getField(response.result, 'protocolVersion');
  if (protocolVersion === 999) {
    return {
      requestedProtocolVersion: 999,
      outcome: 'accepted_unsupported',
      protocolVersion,
      response: redactAcpFrame(response),
    };
  }
  return {
    requestedProtocolVersion: 999,
    outcome:
      typeof protocolVersion === 'number' ? `negotiated_to_${protocolVersion}` : 'missing_version',
    protocolVersion: typeof protocolVersion === 'number' ? protocolVersion : null,
    response: redactAcpFrame(response),
  };
}

async function captureCopilotVersion(copilotPath: string | null): Promise<string | null> {
  if (!copilotPath) {
    return null;
  }

  const proc = Bun.spawn([copilotPath, '--version'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...Bun.env,
      NO_COLOR: '1',
      CI: '1',
    },
  });
  const timeout = Bun.sleep(5_000).then(() => {
    proc.kill('SIGTERM');
    return null;
  });
  const output = proc.exited.then(async (exitCode) => {
    const [stdout, stderr] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
    ]);
    return exitCode === 0 ? `${stdout}${stderr}`.trim() : null;
  });
  return await Promise.race([output, timeout]);
}

async function findCommand(name: string): Promise<string | null> {
  const env = Bun.env as { PATH?: string };
  const proc = Bun.spawn(['which', name], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: env.PATH,
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return null;
  }
  const path = (await streamToText(proc.stdout)).trim();
  return path.length > 0 ? path : null;
}

async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }
  return await new Response(stream).text();
}

async function withScriptedPeer(
  stdoutFrames: Array<JsonValue | string>,
  run: (peer: AcpJsonRpcPeer, writtenFrames: JsonObject[]) => Promise<void>,
  options: { stderrLines?: string[]; keepStdoutOpen?: boolean } = {},
): Promise<void> {
  const stdoutOptions = options.keepStdoutOpen ? { keepOpen: true } : {};
  const stdout = deferredStreamFromLines(
    stdoutFrames.map((frame) => (typeof frame === 'string' ? frame : JSON.stringify(frame))),
    stdoutOptions,
  );
  const stderr = deferredStreamFromLines(options.stderrLines ?? []);
  const writable = new CapturingWritable(() => {
    stdout.flush();
    stderr.flush();
  });
  const peer = new AcpJsonRpcPeer({
    stdin: writable,
    stdout: stdout.stream,
    stderr: stderr.stream,
    requestTimeoutMs: 10,
  });
  try {
    await run(peer, writable.frames);
  } finally {
    peer.close();
    await peer.waitForReaders();
  }
}

async function assertInitializeResultFails(result: JsonObject, code: string): Promise<void> {
  await withScriptedPeer([{ jsonrpc: '2.0', id: 1, result }], async (peer) => {
    await expectRejects(peer.initialize(), code);
  });
}

async function expectRejects(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof AcpProbeError && cause.code === code) {
      return;
    }
    throw cause;
  }
  throw new Error(`expected rejection with ${code}`);
}

function deferredStreamFromLines(
  lines: string[],
  options: { keepOpen?: boolean } = {},
): {
  stream: ReadableStream<Uint8Array>;
  flush(): void;
} {
  let flushed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  return {
    stream,
    flush() {
      if (flushed) {
        return;
      }
      flushed = true;
      if (!streamController) {
        throw new Error('deferred stream controller was not initialized');
      }
      for (const line of lines) {
        streamController.enqueue(textEncoder.encode(`${line}\n`));
      }
      if (!options.keepOpen) {
        streamController.close();
      }
    },
  };
}

class CapturingWritable implements IAcpWritable {
  readonly chunks: Uint8Array[] = [];
  readonly frames: JsonObject[] = [];

  constructor(readonly afterWrite: () => void = () => {}) {}

  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    const text = textDecoder.decode(chunk);
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      const parsed = JSON.parse(line) as JsonObject;
      this.frames.push(parsed);
    }
    this.afterWrite();
  }
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

function permissionResponseFrame(
  request: IJsonRpcRequest,
  policy: AcpReverseRequestPolicy,
): IJsonRpcResponse {
  if (policy === 'unsupported') {
    return unsupportedCallbackResponse(request);
  }
  if (policy === 'cancelled') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        outcome: {
          outcome: 'cancelled',
        },
      },
    };
  }

  const optionId = selectPermissionOption(request.params, policy);
  if (!optionId) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32602,
        message: `No ${policy} permission option was available`,
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      outcome: {
        outcome: 'selected',
        optionId,
      },
    },
  };
}

function unsupportedCallbackResponse(request: IJsonRpcRequest): IJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: request.id,
    error: {
      code: -32601,
      message: `Unsupported ACP client callback: ${request.method}`,
    },
  };
}

function selectPermissionOption(
  params: JsonObject | undefined,
  policy: Extract<AcpReverseRequestPolicy, 'allow' | 'deny'>,
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function getField(object: JsonObject, key: string): JsonValue | undefined {
  return object[key];
}

function extractSessionId(result: JsonValue | undefined): string {
  if (!isJsonObject(result)) {
    throw new AcpProbeError(
      'session/new response is missing result object',
      'missing_session_result',
    );
  }
  const sessionId = getField(result, 'sessionId');
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new AcpProbeError('session/new response is missing sessionId', 'missing_session_id');
  }
  return sessionId;
}

function redactSessionNewResult(result: JsonValue | undefined): JsonValue {
  if (!isJsonObject(result)) {
    return null;
  }
  return {
    keys: Object.keys(result).sort(),
    sessionId: summarizeSessionId(getField(result, 'sessionId')),
    configOptions: summarizeConfigOptions(getField(result, 'configOptions')),
    models: summarizeCatalog(getField(result, 'models'), 'availableModels', 'currentModelId'),
    modes: summarizeCatalog(getField(result, 'modes'), 'availableModes', 'currentModeId'),
  };
}

function summarizeSessionId(value: JsonValue | undefined): JsonValue {
  return typeof value === 'string'
    ? `<REDACTED:sessionId:${textEncoder.encode(value).byteLength}_bytes>`
    : null;
}

function summarizeConfigOptions(value: JsonValue | undefined): JsonValue {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    if (!isJsonObject(item)) {
      return null;
    }
    const id = getField(item, 'id');
    const type = getField(item, 'type');
    const category = getField(item, 'category');
    const currentValue = getField(item, 'currentValue');
    const options = getField(item, 'options');
    return {
      id: typeof id === 'string' ? id : '<unknown>',
      type: typeof type === 'string' ? type : '<unknown>',
      category: typeof category === 'string' ? category : '<unknown>',
      currentValue:
        typeof currentValue === 'string'
          ? `<REDACTED:string:${textEncoder.encode(currentValue).byteLength}_bytes>`
          : (currentValue ?? null),
      optionCount: Array.isArray(options) ? options.length : 0,
    };
  });
}

function summarizeCatalog(
  value: JsonValue | undefined,
  listKey: string,
  currentKey: string,
): JsonValue {
  if (!isJsonObject(value)) {
    return null;
  }

  const list = getField(value, listKey);
  const current = getField(value, currentKey);
  return {
    availableCount: Array.isArray(list) ? list.length : 0,
    current:
      typeof current === 'string'
        ? `<REDACTED:string:${textEncoder.encode(current).byteLength}_bytes>`
        : (current ?? null),
  };
}

function hasConfigOption(result: JsonValue | undefined, optionId: string): boolean {
  if (!isJsonObject(result)) {
    return false;
  }
  const configOptions = getField(result, 'configOptions');
  if (!Array.isArray(configOptions)) {
    return false;
  }
  return configOptions.some((option) => {
    if (!isJsonObject(option)) {
      return false;
    }
    return getField(option, 'id') === optionId;
  });
}

function summarizePromptEvidence(
  promptResponse: IJsonRpcResponse,
  promptMessages: readonly JsonValue[],
  callbackMethods: readonly string[],
): IAcpDiscoveryEvidence['prompt'] {
  const updateMethods = new Set<string>();
  const updateKinds = new Set<string>();
  for (const message of promptMessages) {
    if (!isJsonObject(message)) {
      continue;
    }
    const method = getField(message, 'method');
    if (typeof method === 'string') {
      updateMethods.add(method);
    }
    const params = getField(message, 'params');
    if (!isJsonObject(params)) {
      continue;
    }
    const update = getField(params, 'update');
    if (!isJsonObject(update)) {
      continue;
    }
    const sessionUpdate = getField(update, 'sessionUpdate');
    if (typeof sessionUpdate === 'string') {
      updateKinds.add(sessionUpdate);
    }
  }

  const stopReason = extractStopReason(promptResponse.result);
  return {
    terminalResponse: stopReason ? 'session/prompt response with stopReason' : 'missing stopReason',
    stopReasons: stopReason ? [stopReason] : [],
    updateMethods: [...updateMethods].sort(),
    updateKinds: [...updateKinds].sort(),
    callbackMethods: [...callbackMethods].sort(),
    messageCount: promptMessages.length,
  };
}

function extractStopReason(result: JsonValue | undefined): string | null {
  if (!isJsonObject(result)) {
    return null;
  }
  const stopReason = getField(result, 'stopReason');
  return typeof stopReason === 'string' ? stopReason : null;
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function redactValue(value: unknown, path: string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, [...path, String(index)]));
  }
  if (typeof value === 'string' && isAcpPayloadStringPath(path)) {
    return `<REDACTED:string:${textEncoder.encode(value).byteLength}_bytes>`;
  }
  if (!isJsonObject(value)) {
    return isJsonPrimitive(value) ? value : null;
  }

  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (isSecretKey(key)) {
      output[key] = '<REDACTED:token>';
    } else if (key === 'text' && isPromptTextPath(childPath) && typeof child === 'string') {
      output[key] = `<REDACTED:prompt:${textEncoder.encode(child).byteLength}_bytes>`;
    } else {
      output[key] = redactValue(child, childPath);
    }
  }
  return output;
}

function isSecretKey(key: string): boolean {
  return /authorization|cookie|token|api[_-]?key|password|secret/i.test(key);
}

function isPromptTextPath(path: string[]): boolean {
  return path.includes('prompt') || path.includes('content') || path.includes('input');
}

function isAcpPayloadStringPath(path: string[]): boolean {
  const key = path.at(-1);
  return (
    path.includes('authMethods') ||
    path.includes('_meta') ||
    path.includes('agentCapabilities') ||
    key === 'command' ||
    key === 'args' ||
    key === 'path' ||
    key === 'cwd' ||
    key === 'url' ||
    key === 'uri'
  );
}

function redactDiagnosticText(value: string): string {
  return value
    .replaceAll(
      /\b(?:gh[opsu]_[A-Za-z0-9_]{8,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/gi,
      '<REDACTED:token>',
    )
    .replaceAll(
      /\b[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)[A-Z0-9_]*=[^\s]+/gi,
      '<REDACTED:token>',
    );
}

function toAcpError(cause: unknown, code: string): AcpProbeError {
  if (cause instanceof AcpProbeError) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AcpProbeError(message, code);
}

async function main(): Promise<void> {
  const mode = Bun.argv.includes('--self-test')
    ? 'self-test'
    : Bun.argv.includes('--discovery')
      ? 'discovery'
      : 'initialize';
  const copilotPath = await findCommand('copilot');
  const copilotVersion = await captureCopilotVersion(copilotPath);
  let results: IAcpProbeResult[];
  if (mode === 'self-test') {
    results = await runSelfTests();
  } else if (!copilotPath) {
    results = [
      { name: 'copilot executable', status: 'unsupported', evidence: '`copilot` not found' },
    ];
  } else if (mode === 'discovery') {
    results = await probeDiscovery(copilotPath);
  } else {
    results = [await probeInitialize(copilotPath)];
  }

  const report: IAcpProbeReport = {
    generatedAt: new Date().toISOString(),
    copilotPath,
    copilotVersion,
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}

export { SAFE_SYNTHETIC_PROMPT };
