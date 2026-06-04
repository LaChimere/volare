import { describe, expect, test } from 'bun:test';

import {
  AcpJsonRpcPeer,
  AcpProbeError,
  classifyUnsupportedProtocolResponse,
  redactAcpFrame,
  runSelfTests,
  summarizeInitializeResponse,
} from '../../../scripts/probe-copilot-acp';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

class CapturingWritable {
  readonly chunks: Uint8Array[] = [];

  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }

  text(): string {
    return this.chunks.map((chunk) => textDecoder.decode(chunk)).join('');
  }
}

function createControlledStream(): {
  stream: ReadableStream<Uint8Array>;
  enqueue(text: string): void;
  close(): void;
} {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    }),
    enqueue(text: string) {
      if (closed) {
        throw new Error('stream is already closed');
      }
      if (!streamController) {
        throw new Error('stream controller not initialized');
      }
      streamController.enqueue(textEncoder.encode(text));
    },
    close() {
      if (closed) {
        return;
      }
      if (!streamController) {
        throw new Error('stream controller not initialized');
      }
      closed = true;
      try {
        streamController.close();
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error;
        }
      }
    },
  };
}

function parseWrittenFrame(writable: CapturingWritable): Record<string, unknown> {
  const firstLine = writable.text().trim().split('\n')[0];
  if (!firstLine) {
    throw new Error('expected written frame');
  }
  return JSON.parse(firstLine) as Record<string, unknown>;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error('condition was not met');
}

async function expectAcpError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AcpProbeError);
    expect((error as AcpProbeError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('probe-copilot-acp harness', () => {
  test('self-tests cover initialize, protocol version failures, stderr, and timeout', async () => {
    const results = await runSelfTests();

    expect(results).toHaveLength(8);
    expect(results.map((result) => result.name)).toEqual([
      'valid initialize',
      'malformed JSON',
      'missing protocolVersion',
      'non-integer protocolVersion',
      'unsupported protocolVersion',
      'stderr capture',
      'timeout',
      'json-rpc error response',
    ]);
    expect(results.every((result) => result.status === 'supported')).toBe(true);
  });

  test('writes initialize as NDJSON with clientCapabilities', async () => {
    const stdout = createControlledStream();
    const writable = new CapturingWritable();
    const peer = new AcpJsonRpcPeer({
      stdin: writable,
      stdout: stdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const initialize = peer.initialize();
      await Bun.sleep(0);

      const frame = parseWrittenFrame(writable);
      expect(frame).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
        },
      });
      expect(JSON.stringify(frame)).not.toContain('Content-Length');
      expect(JSON.stringify(frame)).not.toContain('"capabilities"');

      stdout.enqueue(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
            agentInfo: { name: 'fake-acp' },
            authMethods: [],
          },
        }),
      );
      stdout.close();

      await expect(initialize).resolves.toMatchObject({
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: 'fake-acp' },
        authMethods: [],
      });
    } finally {
      peer.close();
      await peer.waitForReaders();
    }
  });

  test('parses split chunks, multiple frames, CRLF, and empty lines', async () => {
    const stdout = createControlledStream();
    const writable = new CapturingWritable();
    const peer = new AcpJsonRpcPeer({
      stdin: writable,
      stdout: stdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const first = peer.request('first');
      const second = peer.request('second');
      await Bun.sleep(0);

      stdout.enqueue('\n');
      stdout.enqueue('{"jsonrpc":"2.0","id":1,"result":{"ok":');
      stdout.enqueue('true}}\r\n{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n');
      stdout.close();

      await expect(first).resolves.toMatchObject({ id: 1, result: { ok: true } });
      await expect(second).resolves.toMatchObject({ id: 2, result: { ok: true } });
    } finally {
      peer.close();
      await peer.waitForReaders();
    }
  });

  test('rejects malformed stdout and timed-out requests explicitly', async () => {
    const malformedStdout = createControlledStream();
    const malformedPeer = new AcpJsonRpcPeer({
      stdin: new CapturingWritable(),
      stdout: malformedStdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const request = malformedPeer.request('initialize');
      await Bun.sleep(0);
      malformedStdout.enqueue('{"jsonrpc":"2.0",\n');
      malformedStdout.close();
      await expectAcpError(request, 'invalid_json');
    } finally {
      malformedPeer.close();
      await malformedPeer.waitForReaders();
    }

    const quietStdout = createControlledStream();
    const quietPeer = new AcpJsonRpcPeer({
      stdin: new CapturingWritable(),
      stdout: quietStdout.stream,
      requestTimeoutMs: 5,
    });
    try {
      await expectAcpError(quietPeer.request('initialize'), 'request_timeout');
    } finally {
      quietPeer.close();
      quietStdout.close();
      await quietPeer.waitForReaders();
    }
  });

  test('records and answers unsupported server-to-client requests explicitly', async () => {
    const stdout = createControlledStream();
    const writable = new CapturingWritable();
    const peer = new AcpJsonRpcPeer({
      stdin: writable,
      stdout: stdout.stream,
      requestTimeoutMs: 100,
    });

    try {
      stdout.enqueue(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'session/request_permission',
          params: { prompt: [{ type: 'text', text: 'approve this' }] },
        })}\n`,
      );
      await waitFor(() => peer.serverRequestMethods.length > 0);

      expect(peer.serverRequestMethods).toEqual(['session/request_permission']);
      const response = writable
        .text()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id?: unknown })
        .find((frame) => frame.id === 99);
      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 99,
        error: {
          code: -32601,
          message: 'Unsupported ACP client callback: session/request_permission',
        },
      });
      expect(JSON.stringify(peer.messages)).not.toContain('approve this');
    } finally {
      peer.close();
      stdout.close();
      await peer.waitForReaders();
    }
  });

  test('can answer permission requests with an explicit allow policy', async () => {
    const stdout = createControlledStream();
    const writable = new CapturingWritable();
    const peer = new AcpJsonRpcPeer({
      stdin: writable,
      stdout: stdout.stream,
      requestTimeoutMs: 100,
      reverseRequestPolicy: {
        'session/request_permission': 'allow',
      },
    });
    try {
      stdout.enqueue(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'session/request_permission',
          params: {
            sessionId: 'sess_123',
            options: [
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            ],
          },
        })}\n`,
      );
      await waitFor(() => peer.serverRequestRecords.length > 0);

      expect(peer.serverRequestRecords).toEqual([
        { method: 'session/request_permission', policy: 'allow' },
      ]);
      expect(JSON.parse(writable.text()) as unknown).toMatchObject({
        jsonrpc: '2.0',
        id: 5,
        result: {
          outcome: {
            outcome: 'selected',
            optionId: 'allow-once',
          },
        },
      });
    } finally {
      peer.close();
      stdout.close();
      await peer.waitForReaders();
    }
  });

  test('constructs session/new and session/prompt frames from observed ACP fixtures', async () => {
    const stdout = createControlledStream();
    const writable = new CapturingWritable();
    const peer = new AcpJsonRpcPeer({
      stdin: writable,
      stdout: stdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const sessionNew = peer.request('session/new', {
        cwd: '/tmp/volare-empty',
        mcpServers: [],
      });
      await Bun.sleep(0);
      expect(parseWrittenFrame(writable)).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/volare-empty',
          mcpServers: [],
        },
      });
      stdout.enqueue('{"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess_123"}}\n');
      await expect(sessionNew).resolves.toMatchObject({
        id: 1,
        result: { sessionId: 'sess_123' },
      });

      const prompt = peer.request('session/prompt', {
        sessionId: 'sess_123',
        prompt: [{ type: 'text', text: 'Reply with the single word OK.' }],
      });
      await Bun.sleep(0);
      const promptFrame = writable
        .text()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id?: unknown; method?: unknown })
        .find((frame) => frame.id === 2);
      expect(promptFrame).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: {
          sessionId: 'sess_123',
          prompt: [{ type: 'text', text: 'Reply with the single word OK.' }],
        },
      });
      stdout.enqueue(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess_123',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'OK' },
            },
          },
        })}\n`,
      );
      stdout.enqueue('{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}\n');
      await expect(prompt).resolves.toMatchObject({
        id: 2,
        result: { stopReason: 'end_turn' },
      });
      expect(peer.messages).toContainEqual(
        expect.objectContaining({
          method: 'session/update',
        }),
      );
      expect(JSON.stringify(peer.messages)).not.toContain('Reply with the single word OK.');
    } finally {
      peer.close();
      stdout.close();
      await peer.waitForReaders();
    }
  });

  test('sends session/cancel notification and drains prompt response to cancelled', async () => {
    const stdout = createControlledStream();
    const writable = new CapturingWritable();
    const peer = new AcpJsonRpcPeer({
      stdin: writable,
      stdout: stdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const prompt = peer.request('session/prompt', {
        sessionId: 'sess_123',
        prompt: [{ type: 'text', text: 'Reply slowly.' }],
      });
      await Bun.sleep(0);
      await peer.notify('session/cancel', { sessionId: 'sess_123' });

      const cancelFrame = writable
        .text()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id?: unknown; method?: unknown })
        .find((frame) => frame.method === 'session/cancel');
      expect(cancelFrame).toMatchObject({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'sess_123' },
      });
      expect(cancelFrame).not.toHaveProperty('id');

      stdout.enqueue('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"cancelled"}}\n');
      await expect(prompt).resolves.toMatchObject({
        id: 1,
        result: { stopReason: 'cancelled' },
      });
    } finally {
      peer.close();
      stdout.close();
      await peer.waitForReaders();
    }
  });

  test('rejects pending requests when stdout closes unexpectedly', async () => {
    const stdout = createControlledStream();
    const peer = new AcpJsonRpcPeer({
      stdin: new CapturingWritable(),
      stdout: stdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const request = peer.request('session/new', {
        cwd: '/tmp/volare-empty',
        mcpServers: [],
      });
      await Bun.sleep(0);
      stdout.close();
      await expectAcpError(request, 'stdout_closed');
    } finally {
      peer.close();
      await peer.waitForReaders();
    }
  });

  test('validates initialize protocolVersion variants', () => {
    expect(() => summarizeInitializeResponse({ protocolVersion: 1 })).not.toThrow();
    expect(() => summarizeInitializeResponse({})).toThrow('missing protocolVersion');
    expect(() => summarizeInitializeResponse({ protocolVersion: '1' })).toThrow('not an integer');
    expect(() => summarizeInitializeResponse({ protocolVersion: 999 })).toThrow('unsupported');
  });

  test('classifies unsupported protocolVersion negotiation without conflating client refusal', () => {
    expect(
      classifyUnsupportedProtocolResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: 1 },
      }),
    ).toMatchObject({
      requestedProtocolVersion: 999,
      outcome: 'negotiated_to_1',
      protocolVersion: 1,
    });
    expect(
      classifyUnsupportedProtocolResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: 'unsupported' },
      }),
    ).toMatchObject({
      requestedProtocolVersion: 999,
      outcome: 'rejected_with_error',
    });
  });

  test('redacts prompt text and token-like fields while preserving shape', () => {
    const redacted = redactAcpFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: {
        sessionId: 'session_1',
        prompt: [{ type: 'text', text: 'secret prompt content' }],
        authorization: 'Bearer ghp_secret',
      },
    });

    expect(redacted).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: {
        sessionId: 'session_1',
        prompt: [{ type: 'text', text: '<REDACTED:prompt:21_bytes>' }],
        authorization: '<REDACTED:token>',
      },
    });
  });

  test('summarizes auth method metadata without leaking local command payloads', () => {
    const redacted = redactAcpFrame({
      protocolVersion: 1,
      authMethods: [
        {
          id: 'terminal-auth',
          _meta: {
            command: '/Users/example/bin/copilot',
            args: ['auth', 'login'],
            url: 'https://example.test/login?token=secret',
          },
        },
      ],
      agentCapabilities: {
        customPath: '/Users/example/project',
        streaming: true,
      },
    });

    expect(JSON.stringify(redacted)).not.toContain('/Users/example');
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(redacted).toEqual({
      protocolVersion: 1,
      authMethods: [
        {
          id: '<REDACTED:string:13_bytes>',
          _meta: {
            command: '<REDACTED:string:26_bytes>',
            args: ['<REDACTED:string:4_bytes>', '<REDACTED:string:5_bytes>'],
            url: '<REDACTED:string:39_bytes>',
          },
        },
      ],
      agentCapabilities: {
        customPath: '<REDACTED:string:22_bytes>',
        streaming: true,
      },
    });
  });
});
