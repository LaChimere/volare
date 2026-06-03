import { describe, expect, test } from 'bun:test';

import { AcpCopilotPromptRunner } from '../../../src/backends/copilot-cli/acp-runner';

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
  sessionId = `session_${Math.random().toString(36).slice(2)}`;

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.killed.push(signal);
    this.resolveExit(signal === 'SIGTERM' ? 143 : 137);
    this.stdout.close();
    this.stderr.close();
  }

  handleInput(input: string): void {
    this.inputs.push(input);
    for (const line of input.trim().split('\n').filter(Boolean)) {
      const frame = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
      if (frame.method === 'initialize') {
        this.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } });
      } else if (frame.method === 'session/new') {
        this.send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: this.sessionId } });
      } else if (frame.method === 'session/prompt') {
        this.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello' },
            },
          },
        });
        this.send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
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
      streamController.enqueue(textEncoder.encode(text));
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

  test('fails explicitly when the ACP worker cap is exhausted', async () => {
    const runner = new AcpCopilotPromptRunner({
      maxWorkers: 1,
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
    ).rejects.toThrow('ACP worker cap exhausted');
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
        reason: expect.objectContaining({ code: 'backend_worker_cap_exhausted' }),
      },
    ]);
    expect(processes).toHaveLength(1);
  });

  test('removes exited idle workers from the cap', async () => {
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
    });

    await collect(runner.run('prompt text', { backendSessionId: 'backend_1', cwd: '/tmp/a' }));
    processes[0]?.resolveExit(0);
    await Bun.sleep(0);

    await expect(
      collect(runner.run('prompt text', { backendSessionId: 'backend_2', cwd: '/tmp/b' })),
    ).resolves.toEqual(['hello']);
    expect(processes).toHaveLength(2);
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
