import { describe, expect, test } from 'bun:test';

import { AcpCopilotPromptRunner } from '../../../src/backends/copilot-cli/acp-runner';
import { RuntimeCapabilityRegistry } from '../../../src/core/runtime-capability-registry';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

class FakeAcpProcess {
  readonly stdout = createControlledStream();
  readonly stderr = createControlledStream();
  resolveExit!: (code: number | null) => void;
  readonly stdin = {
    write: (chunk: Uint8Array) => {
      this.handleInput(textDecoder.decode(chunk));
    },
    end: () => {},
  };
  readonly exited = new Promise<number | null>((resolve) => {
    this.resolveExit = resolve;
  });
  readonly inputs: string[] = [];
  killed: Array<'SIGTERM' | 'SIGKILL'> = [];
  ignoreSigterm = false;
  sessionId = `session_${Math.random().toString(36).slice(2)}`;
  authMethods: unknown[] = [];
  sessionNewAuthFailuresRemaining = 0;
  authenticateShouldFail = false;
  authenticateCalls = 0;
  promptMode: 'normal' | 'cancelled-on-cancel' | 'end-turn-on-cancel' | 'never' = 'normal';
  pendingPromptId: number | undefined;
  restoreNormalAfterCancel = true;
  normalPromptDelayMs = 0;
  verificationText: string | undefined;

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.killed.push(signal);
    if (signal === 'SIGTERM' && this.ignoreSigterm) {
      return;
    }
    this.resolveExit(signal === 'SIGTERM' ? 143 : 137);
    this.stdout.close();
    this.stderr.close();
  }

  handleInput(input: string): void {
    this.inputs.push(input);
    for (const line of input.trim().split('\n').filter(Boolean)) {
      const frame = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
      if (frame.method === 'initialize') {
        this.send({
          jsonrpc: '2.0',
          id: frame.id,
          result: { protocolVersion: 1, authMethods: this.authMethods },
        });
      } else if (frame.method === 'authenticate') {
        this.authenticateCalls += 1;
        if (this.authenticateShouldFail) {
          this.send({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32001, message: 'Authentication failed' },
          });
        } else {
          this.send({ jsonrpc: '2.0', id: frame.id, result: {} });
        }
      } else if (frame.method === 'session/new') {
        if (this.sessionNewAuthFailuresRemaining > 0) {
          this.sessionNewAuthFailuresRemaining -= 1;
          this.send({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32001, message: 'Authentication required' },
          });
          continue;
        }
        this.send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: this.sessionId } });
      } else if (frame.method === 'session/prompt') {
        if (this.promptMode === 'never') {
          this.pendingPromptId = typeof frame.id === 'number' ? frame.id : undefined;
          continue;
        }
        if (this.promptMode === 'cancelled-on-cancel' || this.promptMode === 'end-turn-on-cancel') {
          this.pendingPromptId = typeof frame.id === 'number' ? frame.id : undefined;
          continue;
        }
        const promptText = JSON.stringify(frame.params ?? {});
        const responseText = promptText.includes('AFTER')
          ? (this.verificationText ?? 'AFTER')
          : 'hello';
        const sendPromptResponse = () => {
          this.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: responseText },
              },
            },
          });
          this.send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
        };
        if (this.normalPromptDelayMs > 0) {
          setTimeout(sendPromptResponse, this.normalPromptDelayMs);
        } else {
          sendPromptResponse();
        }
      } else if (frame.method === 'session/cancel') {
        if (this.pendingPromptId === undefined) {
          continue;
        }
        const stopReason =
          this.promptMode === 'cancelled-on-cancel'
            ? 'cancelled'
            : this.promptMode === 'end-turn-on-cancel'
              ? 'end_turn'
              : undefined;
        if (stopReason) {
          this.send({
            jsonrpc: '2.0',
            id: this.pendingPromptId,
            result: { stopReason },
          });
          if (stopReason === 'cancelled' && this.restoreNormalAfterCancel) {
            this.promptMode = 'normal';
          }
        }
      }
    }
  }

  send(frame: unknown): void {
    this.stdout.enqueue(`${JSON.stringify(frame)}\n`);
  }
}

function createControlledStream(): {
  stream: ReadableStream<Uint8Array>;
  enqueue(text: string): void;
  close(): void;
} {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  return {
    stream,
    enqueue(text: string) {
      if (!streamController || closed) {
        return;
      }
      try {
        streamController.enqueue(textEncoder.encode(text));
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error;
        }
      }
    },
    close() {
      if (!streamController || closed) {
        return;
      }
      closed = true;
      try {
        streamController.close();
      } catch {
        // Test helper tolerates reader cancellation.
      }
    },
  };
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of iterable) {
    output.push(chunk);
  }
  return output;
}

describe('AcpCopilotPromptRunner', () => {
  test('streams ACP text deltas through ICopilotPromptRunner', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });

    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).resolves.toEqual(['hello']);
    expect(processes).toHaveLength(1);
  });

  test('cancel kills only the owning active worker', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        const originalHandle = proc.handleInput.bind(proc);
        proc.handleInput = (input: string) => {
          if (input.includes('session/prompt')) {
            proc.inputs.push(input);
            return;
          }
          originalHandle(input);
        };
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );
    await Bun.sleep(5);

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });
    expect(processes[0]?.killed).toContain('SIGTERM');
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });

  test('drops ACP text deltas after cancel stops output', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.ignoreSigterm = true;
        const originalHandle = proc.handleInput.bind(proc);
        proc.handleInput = (input: string) => {
          if (input.includes('session/prompt')) {
            proc.inputs.push(input);
            return;
          }
          originalHandle(input);
        };
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });
    const proc = processes[0];
    expect(proc).toBeDefined();
    if (!proc) {
      throw new Error('expected spawned process');
    }
    proc.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: proc.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'late text' },
        },
      },
    });

    await expect(firstChunk).resolves.toBeInstanceOf(Error);
    expect(proc.killed).toEqual(['SIGTERM']);
  });

  test('native cancel reuses worker after cancelled stopReason and verification', async () => {
    const processes: FakeAcpProcess[] = [];
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      now: () => 1000,
    });
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'native',
      capabilityRegistry,
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.promptMode = 'cancelled-on-cancel';
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });
    expect(capabilityRegistry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'native-reusable',
      support: 'supported',
      source: 'probe',
    });

    const proc = processes[0];
    expect(proc?.inputs.join('\n')).toContain('session/cancel');
    expect(proc?.killed).toEqual([]);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
    await expect(
      collect(runner.run('next prompt', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).resolves.toEqual(['hello']);
    expect(processes).toHaveLength(1);
  });

  test('auto cancel uses kill without native reusable support evidence', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'auto',
      spawn: () => {
        const proc = new FakeAcpProcess();
        const originalHandle = proc.handleInput.bind(proc);
        proc.handleInput = (input: string) => {
          if (input.includes('session/prompt')) {
            proc.inputs.push(input);
            return;
          }
          originalHandle(input);
        };
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });

    expect(processes[0]?.killed).toEqual(['SIGTERM']);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });

  test('auto cancel uses native when reusable support is proven in memory', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'auto',
      nativeCancelSupport: 'native-reusable',
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.promptMode = 'cancelled-on-cancel';
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });

    expect(processes[0]?.killed).toEqual([]);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });

  test('new prompts wait for in-flight native cancellation verification', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'native',
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.promptMode = 'cancelled-on-cancel';
        proc.normalPromptDelayMs = 10;
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    const cancel = runner.cancel('backend_1');
    const next = collect(runner.run('next prompt', { backendSessionId: 'backend_1', cwd: '/tmp' }));

    await expect(cancel).resolves.toEqual({ status: 'cancelled' });
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
    await expect(next).resolves.toEqual(['hello']);
    expect(processes).toHaveLength(1);
    expect(processes[0]?.killed).toEqual([]);
  });

  test('native cancel falls back to kill on wrong stopReason', async () => {
    const processes: FakeAcpProcess[] = [];
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      now: () => 1000,
    });
    capabilityRegistry.updateAcpNativeCancel({
      classification: 'native-reusable',
      source: 'probe',
    });
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'native',
      capabilityRegistry,
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.promptMode = 'end-turn-on-cancel';
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });
    expect(capabilityRegistry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'unsupported',
      support: 'unsupported',
      source: 'probe',
      reason: 'native_wrong_stop_reason',
    });

    expect(processes[0]?.inputs.join('\n')).toContain('session/cancel');
    expect(processes[0]?.killed).toEqual(['SIGTERM']);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });

  test('native cancel falls back when reuse verification does not settle', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'native',
      nativeCancelWaitMs: 1,
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.promptMode = 'cancelled-on-cancel';
        proc.restoreNormalAfterCancel = false;
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });

    expect(processes[0]?.killed).toEqual(['SIGTERM']);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });

  test('native cancel falls back when reuse verification output is contaminated', async () => {
    const processes: FakeAcpProcess[] = [];
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      now: () => 1000,
    });
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'native',
      capabilityRegistry,
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.promptMode = 'cancelled-on-cancel';
        proc.verificationText = '1\n2\nAFTER';
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });
    expect(capabilityRegistry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'native-terminal-only',
      support: 'unsupported',
      source: 'probe',
      reason: 'reuse_verification_leaked_output',
    });

    expect(processes[0]?.killed).toEqual(['SIGTERM']);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });

  test('native cancel falls back to kill when native wait expires', async () => {
    const processes: FakeAcpProcess[] = [];
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      now: () => 1000,
    });
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'native',
      nativeCancelWaitMs: 1,
      capabilityRegistry,
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.promptMode = 'never';
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });
    expect(capabilityRegistry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'unknown',
      support: 'unknown',
      source: 'probe',
      reason: 'native_timeout',
    });

    expect(processes[0]?.killed).toEqual(['SIGTERM']);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });

  test('native wait and fallback kill share the force cancel budget', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      cancelStrategy: 'native',
      nativeCancelWaitMs: 50,
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.promptMode = 'never';
        proc.ignoreSigterm = true;
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(
      runner.cancel('backend_1', { timeoutMs: 5, forceAfterTimeout: true }),
    ).resolves.toEqual({ status: 'timed_out' });

    expect(processes[0]?.killed).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });

  test('aborts an active ACP prompt when the run signal aborts', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        const originalHandle = proc.handleInput.bind(proc);
        proc.handleInput = (input: string) => {
          if (input.includes('session/prompt')) {
            proc.inputs.push(input);
            return;
          }
          originalHandle(input);
        };
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const controller = new AbortController();
    const iterator = runner
      .run('prompt text', {
        backendSessionId: 'backend_1',
        cwd: '/tmp',
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    controller.abort();

    await expect(firstChunk).resolves.toBeInstanceOf(Error);
    expect(processes[0]?.killed).toContain('SIGTERM');
  });

  test('cleans up a spawned process when ACP startup fails', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.handleInput = (input: string) => {
          proc.inputs.push(input);
          if (input.includes('initialize')) {
            proc.send({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32001, message: 'auth required' },
            });
          }
        };
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });

    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).rejects.toThrow('auth required');
    expect(processes[0]?.killed).toContain('SIGTERM');
  });

  test('authenticates once and retries session/new when auth is required', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.authMethods = [{ id: 'copilot-login' }];
        proc.sessionNewAuthFailuresRemaining = 1;
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });

    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).resolves.toEqual(['hello']);
    expect(processes[0]?.authenticateCalls).toBe(1);
  });

  test('cleans up and reports auth failures clearly', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.authMethods = [{ id: 'copilot-login' }];
        proc.sessionNewAuthFailuresRemaining = 1;
        proc.authenticateShouldFail = true;
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });

    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).rejects.toThrow('ACP authentication failed');
    expect(processes[0]?.killed).toContain('SIGTERM');
  });

  test('does not loop when authentication retry still cannot create a session', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.authMethods = [{ id: 'copilot-login' }];
        proc.sessionNewAuthFailuresRemaining = 2;
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });

    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).rejects.toThrow('ACP authentication is required');
    expect(processes[0]?.authenticateCalls).toBe(1);
    expect(processes[0]?.killed).toContain('SIGTERM');
  });

  test('reports missing auth methods without retry loops', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.sessionNewAuthFailuresRemaining = 1;
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });

    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).rejects.toThrow('did not advertise a usable auth method');
    expect(processes[0]?.authenticateCalls).toBe(0);
    expect(processes[0]?.killed).toContain('SIGTERM');
  });

  test('times out explicitly when ACP worker admission is exhausted', async () => {
    const runner = new AcpCopilotPromptRunner({
      maxWorkers: 1,
      admissionTimeoutMs: 1,
      spawn: () => {
        const proc = new FakeAcpProcess();
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });

    await collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp/a' }));
    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_2', cwd: '/tmp/b' })),
    ).rejects.toMatchObject({ code: 'backend_worker_admission_timeout' });
  });

  test('admits queued ACP workers in FIFO order', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      maxWorkers: 1,
      admissionTimeoutMs: 1000,
      spawn: () => {
        const proc = new FakeAcpProcess();
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });
    await collect(runner.run('first', { backendSessionId: 'backend_1', cwd: '/tmp/a' }));

    const second = collect(runner.run('second', { backendSessionId: 'backend_2', cwd: '/tmp/b' }));
    const third = collect(runner.run('third', { backendSessionId: 'backend_3', cwd: '/tmp/c' }));
    await Bun.sleep(0);
    expect(processes).toHaveLength(1);

    await runner.dispose('backend_1');
    await expect(second).resolves.toEqual(['hello']);
    expect(processes).toHaveLength(2);

    await runner.dispose('backend_2');
    await expect(third).resolves.toEqual(['hello']);
    expect(processes).toHaveLength(3);
  });

  test('removes queued ACP worker admission when the request aborts', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      maxWorkers: 1,
      admissionTimeoutMs: 1000,
      spawn: () => {
        const proc = new FakeAcpProcess();
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });
    await collect(runner.run('first', { backendSessionId: 'backend_1', cwd: '/tmp/a' }));
    const controller = new AbortController();
    const second = collect(
      runner.run('second', {
        backendSessionId: 'backend_2',
        cwd: '/tmp/b',
        signal: controller.signal,
      }),
    );

    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'backend_cancelled' });
    await runner.dispose('backend_1');
    await expect(
      collect(runner.run('third', { backendSessionId: 'backend_3', cwd: '/tmp/c' })),
    ).resolves.toEqual(['hello']);
    expect(processes).toHaveLength(2);
  });

  test('rejects concurrent prompts on the same ACP worker', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        const originalHandle = proc.handleInput.bind(proc);
        proc.handleInput = (input: string) => {
          if (input.includes('session/prompt')) {
            proc.inputs.push(input);
            return;
          }
          originalHandle(input);
        };
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const iterator = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    await expect(
      collect(runner.run('second prompt', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).rejects.toThrow('already has an active prompt');
    await runner.cancel('backend_1');
    await firstChunk;
  });

  test('reserves worker creation for concurrent first prompts', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      maxWorkers: 1,
      admissionTimeoutMs: 1,
    });

    const first = collect(
      runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp/a' }),
    );
    const second = collect(
      runner.run('prompt text', { backendSessionId: 'backend_2', cwd: '/tmp/b' }),
    );

    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      { status: 'fulfilled', value: ['hello'] },
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'backend_worker_admission_timeout' }),
      },
    ]);
    expect(processes).toHaveLength(1);
  });

  test('removes exited idle workers from the cap', async () => {
    const processes: FakeAcpProcess[] = [];
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      now: () => 1000,
    });
    capabilityRegistry.updateAcpNativeCancel({
      classification: 'native-reusable',
      source: 'probe',
    });
    const runner = new AcpCopilotPromptRunner({
      capabilityRegistry,
      spawn: () => {
        const proc = new FakeAcpProcess();
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      maxWorkers: 1,
    });

    await collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp/a' }));
    processes[0]?.resolveExit(0);
    await Bun.sleep(0);
    expect(capabilityRegistry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'unknown',
      support: 'unknown',
      source: 'unknown',
      reason: 'backend_worker_exited',
    });

    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_2', cwd: '/tmp/b' })),
    ).resolves.toEqual(['hello']);
    expect(processes).toHaveLength(2);
  });

  test('invalidates native cancel observations when disposing a worker', async () => {
    const processes: FakeAcpProcess[] = [];
    const capabilityRegistry = new RuntimeCapabilityRegistry({
      runtimeMode: 'acp',
      maxActiveTurns: 2,
      now: () => 1000,
    });
    capabilityRegistry.updateAcpNativeCancel({
      classification: 'native-reusable',
      source: 'probe',
    });
    const runner = new AcpCopilotPromptRunner({
      capabilityRegistry,
      spawn: () => {
        const proc = new FakeAcpProcess();
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
    });

    await collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp/a' }));
    await runner.dispose('backend_1');

    expect(capabilityRegistry.snapshot().acp.nativeCancel).toMatchObject({
      classification: 'unknown',
      support: 'unknown',
      source: 'unknown',
      reason: 'backend_session_disposed',
    });
  });

  test('evicts idle workers before enforcing the worker cap', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      maxWorkers: 1,
      idleTimeoutMs: 1,
    });

    await collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp/a' }));
    await Bun.sleep(2);
    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_2', cwd: '/tmp/b' })),
    ).resolves.toEqual(['hello']);

    expect(processes).toHaveLength(2);
    expect(processes[0]?.killed).toContain('SIGTERM');
  });

  test('cancel kills a worker that is still starting up', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        proc.handleInput = (input: string) => {
          proc.inputs.push(input);
        };
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const firstChunk = runner
      .run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]()
      .next()
      .catch((error) => error);
    await waitFor(() => processes.some((proc) => proc.inputs.join('\n').includes('initialize')));

    await expect(runner.cancel('backend_1')).resolves.toEqual({ status: 'cancelled' });
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
    expect(processes[0]?.killed).toContain('SIGTERM');
  });

  test('abort during ACP worker startup releases admission for the next worker', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      maxWorkers: 1,
      admissionTimeoutMs: 1000,
      spawn: () => {
        const proc = new FakeAcpProcess();
        if (processes.length === 0) {
          const originalHandle = proc.handleInput.bind(proc);
          proc.handleInput = (input: string) => {
            if (input.includes('session/new')) {
              proc.inputs.push(input);
              return;
            }
            originalHandle(input);
          };
        }
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1000,
    });
    const controller = new AbortController();
    const first = collect(
      runner.run('first', {
        backendSessionId: 'backend_1',
        cwd: '/tmp/a',
        signal: controller.signal,
      }),
    );
    await waitFor(() => processes.some((proc) => proc.inputs.join('\n').includes('session/new')));

    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'backend_cancelled' });
    await expect(
      collect(runner.run('second', { backendSessionId: 'backend_2', cwd: '/tmp/b' })),
    ).resolves.toEqual(['hello']);
  });

  test('reports not_found when no ACP turn is active', async () => {
    const runner = new AcpCopilotPromptRunner();

    await expect(runner.cancel('missing')).resolves.toEqual({ status: 'not_found' });
  });

  test('force cancel times out and does not kill a replacement worker', async () => {
    const processes: FakeAcpProcess[] = [];
    const runner = new AcpCopilotPromptRunner({
      spawn: () => {
        const proc = new FakeAcpProcess();
        if (processes.length === 0) {
          proc.ignoreSigterm = true;
          const originalHandle = proc.handleInput.bind(proc);
          proc.handleInput = (input: string) => {
            if (input.includes('session/prompt')) {
              proc.inputs.push(input);
              return;
            }
            originalHandle(input);
          };
        }
        processes.push(proc);
        return {
          stdin: proc.stdin,
          stdout: proc.stdout.stream,
          stderr: proc.stderr.stream,
          exited: proc.exited,
          kill: (signal) => proc.kill(signal),
        };
      },
      requestTimeoutMs: 1_000,
    });
    const iterator = runner
      .run('first prompt', { backendSessionId: 'backend_1', cwd: '/tmp' })
      [Symbol.asyncIterator]();
    const firstChunk = iterator.next().catch((error) => error);
    await waitFor(() =>
      processes.some((proc) => proc.inputs.join('\n').includes('session/prompt')),
    );

    const cancel = runner.cancel('backend_1', { timeoutMs: 5, forceAfterTimeout: true });
    await Bun.sleep(0);
    await expect(
      collect(runner.run('replacement prompt', { backendSessionId: 'backend_1', cwd: '/tmp' })),
    ).resolves.toEqual(['hello']);

    await expect(cancel).resolves.toEqual({ status: 'timed_out' });
    expect(processes[0]?.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(processes[1]?.killed).toEqual([]);
    await expect(firstChunk).resolves.toBeInstanceOf(Error);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error('condition was not met');
}
