import { describe, expect, test } from 'bun:test';

import {
  AcpJsonRpcPeer,
  AcpProtocolError,
  parseAcpInitializeResponse,
  parseAcpSessionNewResponse,
} from '../../../src/backends/copilot-cli/acp';

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

class ThrowingWritable {
  write(): void {
    throw new Error('broken pipe');
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
      if (!streamController || closed) {
        throw new Error('stream is not writable');
      }
      streamController.enqueue(textEncoder.encode(text));
    },
    close() {
      if (closed || !streamController) {
        return;
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
    expect(error).toBeInstanceOf(AcpProtocolError);
    expect((error as AcpProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('AcpJsonRpcPeer', () => {
  test('initializes with clientCapabilities over NDJSON', async () => {
    const stdout = createControlledStream();
    const stdin = new CapturingWritable();
    const peer = new AcpJsonRpcPeer({
      stdin,
      stdout: stdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const initialize = peer.initialize();
      await Bun.sleep(0);
      expect(JSON.parse(stdin.text()) as unknown).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      });
      stdout.enqueue(
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[]}}\n',
      );
      await expect(initialize).resolves.toMatchObject({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      });
    } finally {
      peer.close();
      stdout.close();
      await peer.waitForReaders();
    }
  });

  test('validates initialize and session/new response shapes', () => {
    expect(() => parseAcpInitializeResponse({ protocolVersion: 1 })).not.toThrow();
    expect(() => parseAcpInitializeResponse({ protocolVersion: 999 })).toThrow(
      'ACP protocolVersion is unsupported',
    );
    expect(() => parseAcpInitializeResponse({ protocolVersion: '1' })).toThrow(
      'protocolVersion must be an integer',
    );
    expect(() => parseAcpSessionNewResponse({ sessionId: 'session_1' })).not.toThrow();
    expect(() => parseAcpSessionNewResponse(null)).toThrow(
      'ACP session/new result must be an object',
    );
    expect(() => parseAcpSessionNewResponse({})).toThrow('must include sessionId');
  });

  test('answers permission callbacks with explicit policy', async () => {
    const stdout = createControlledStream();
    const stdin = new CapturingWritable();
    const peer = new AcpJsonRpcPeer({
      stdin,
      stdout: stdout.stream,
      requestTimeoutMs: 100,
      permissionPolicy: 'deny',
    });
    try {
      stdout.enqueue(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'session/request_permission',
          params: {
            options: [
              { optionId: 'allow-once', kind: 'allow_once' },
              { optionId: 'reject-once', kind: 'reject_once' },
            ],
          },
        })}\n`,
      );
      await waitFor(() => stdin.text().includes('reject-once'));
      expect(JSON.parse(stdin.text()) as unknown).toMatchObject({
        jsonrpc: '2.0',
        id: 5,
        result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
      });
    } finally {
      peer.close();
      stdout.close();
      await peer.waitForReaders();
    }
  });

  test('rejects malformed stdout, unexpected close, and timeouts explicitly', async () => {
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
      await expectAcpError(request, 'acp_invalid_json');
    } finally {
      malformedPeer.close();
      malformedStdout.close();
      await malformedPeer.waitForReaders();
    }

    const closedStdout = createControlledStream();
    const closedPeer = new AcpJsonRpcPeer({
      stdin: new CapturingWritable(),
      stdout: closedStdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const request = closedPeer.request('session/new');
      await Bun.sleep(0);
      closedStdout.close();
      await expectAcpError(request, 'acp_stdout_closed');
    } finally {
      closedPeer.close();
      await closedPeer.waitForReaders();
    }

    const quietStdout = createControlledStream();
    const quietPeer = new AcpJsonRpcPeer({
      stdin: new CapturingWritable(),
      stdout: quietStdout.stream,
      requestTimeoutMs: 5,
    });
    try {
      await expectAcpError(quietPeer.request('session/new'), 'acp_request_timeout');
    } finally {
      quietPeer.close();
      quietStdout.close();
      await quietPeer.waitForReaders();
    }
  });

  test('rejects JSON-RPC error responses with server error context', async () => {
    const stdout = createControlledStream();
    const peer = new AcpJsonRpcPeer({
      stdin: new CapturingWritable(),
      stdout: stdout.stream,
      requestTimeoutMs: 100,
    });
    try {
      const request = peer.request('session/new');
      await Bun.sleep(0);
      stdout.enqueue(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"auth required"}}\n',
      );
      await expectAcpError(request, 'acp_response_error');
    } finally {
      peer.close();
      stdout.close();
      await peer.waitForReaders();
    }
  });

  test('cleans pending requests when stdin write fails', async () => {
    const stdout = createControlledStream();
    const peer = new AcpJsonRpcPeer({
      stdin: new ThrowingWritable(),
      stdout: stdout.stream,
      requestTimeoutMs: 5,
    });
    try {
      await expect(peer.request('session/new')).rejects.toThrow('broken pipe');
      await Bun.sleep(10);
    } finally {
      peer.close();
      stdout.close();
      await peer.waitForReaders();
    }
  });
});
