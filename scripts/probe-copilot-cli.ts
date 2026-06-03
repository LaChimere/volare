type ProbeStatus = 'supported' | 'unsupported' | 'unknown' | 'skipped' | 'failed';

interface ICommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface IProbeResult {
  name: string;
  status: ProbeStatus;
  evidence: string;
  command?: string;
}

interface IProbeReport {
  generatedAt: string;
  workspace: string;
  copilotPath: string | null;
  results: IProbeResult[];
  approvalCapabilityMetadata: {
    permissionRequests: boolean;
    externalApprovalDecisions: boolean;
    backendInternalPauseResume: boolean;
    decision: 'external-decisions' | 'backend-internal-pause-resume' | 'unsupported';
    reason: string;
  };
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }

  return await new Response(stream).text();
}

async function runCommand(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<ICommandResult> {
  const proc = Bun.spawn([command, ...args], {
    stdin: options.stdin ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...Bun.env,
      NO_COLOR: '1',
      CI: '1',
    },
  });

  if (options.stdin && proc.stdin) {
    proc.stdin.write(textEncoder.encode(options.stdin));
    proc.stdin.end();
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, options.timeoutMs ?? 15_000);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      streamToText(proc.stdout),
      streamToText(proc.stderr),
    ]);

    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function findCommand(name: string): Promise<string | null> {
  const result = await runCommand('which', [name], { timeoutMs: 5_000 });
  if (result.exitCode !== 0) {
    return null;
  }

  const path = result.stdout.trim();
  return path.length > 0 ? path : null;
}

function summarize(result: ICommandResult, maxLength = 240): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim().replaceAll(/\s+/g, ' ');
  if (combined.length === 0) {
    return result.timedOut ? 'timed out without output' : 'no output';
  }

  return combined.length > maxLength ? `${combined.slice(0, maxLength)}...` : combined;
}

async function probeVersion(copilotPath: string): Promise<IProbeResult> {
  const result = await runCommand(copilotPath, ['--version'], { timeoutMs: 10_000 });
  return {
    name: 'backend startup',
    status: result.exitCode === 0 ? 'supported' : 'failed',
    command: 'copilot --version',
    evidence: summarize(result),
  };
}

async function probeHelp(copilotPath: string): Promise<IProbeResult> {
  const result = await runCommand(copilotPath, ['--help'], { timeoutMs: 10_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const hasAcp = output.includes('--acp');
  const hasPrompt = output.includes('--prompt');
  const hasPermissionFlags = output.includes('--allow-tool') && output.includes('--deny-tool');

  return {
    name: 'cli capability flags',
    status:
      result.exitCode === 0 && hasAcp && hasPrompt && hasPermissionFlags ? 'supported' : 'unknown',
    command: 'copilot --help',
    evidence: `--acp=${hasAcp}; --prompt=${hasPrompt}; permissionFlags=${hasPermissionFlags}`,
  };
}

async function probeNonInteractivePrompt(copilotPath: string): Promise<IProbeResult> {
  const result = await runCommand(
    copilotPath,
    [
      '--no-color',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--log-level',
      'error',
      '--stream',
      'off',
      '--output-format',
      'json',
      '--prompt',
      'Reply with exactly VOLARE_PROBE_OK and no other text.',
    ],
    { timeoutMs: 60_000 },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const sawExpectedText = output.includes('VOLARE_PROBE_OK');

  return {
    name: 'session creation, prompt send, and text response',
    status: result.exitCode === 0 && sawExpectedText ? 'supported' : 'unknown',
    command: 'copilot --prompt <safe text> --output-format json --stream off',
    evidence: sawExpectedText ? 'received VOLARE_PROBE_OK' : summarize(result),
  };
}

async function probeStreamingPrompt(copilotPath: string): Promise<IProbeResult> {
  const result = await runCommand(
    copilotPath,
    [
      '--no-color',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--log-level',
      'error',
      '--stream',
      'on',
      '--output-format',
      'json',
      '--prompt',
      'Reply with exactly VOLARE_STREAM_PROBE_OK and no other text.',
    ],
    { timeoutMs: 60_000 },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const sawExpectedText = output.includes('VOLARE_STREAM_PROBE_OK');

  return {
    name: 'streaming text',
    status: result.exitCode === 0 && sawExpectedText ? 'supported' : 'unknown',
    command: 'copilot --prompt <safe text> --output-format json --stream on',
    evidence: sawExpectedText ? 'received VOLARE_STREAM_PROBE_OK' : summarize(result),
  };
}

async function probeAcpStartup(copilotPath: string): Promise<IProbeResult> {
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

  let exited = false;
  const exitPromise = proc.exited.then(() => {
    exited = true;
  });
  await Promise.race([exitPromise, Bun.sleep(1_500)]);

  const status: ProbeStatus = exited ? 'unknown' : 'supported';
  proc.kill('SIGTERM');

  const [stdout, stderr] = await Promise.all([
    streamToText(proc.stdout),
    streamToText(proc.stderr),
  ]);

  return {
    name: 'ACP server startup',
    status,
    command: 'copilot --acp',
    evidence: exited
      ? `process exited during startup: ${textDecoder.decode(textEncoder.encode(`${stdout}\n${stderr}`)).trim()}`
      : 'process stayed alive waiting for ACP client traffic',
  };
}

async function probeAcpInitialize(copilotPath: string): Promise<IProbeResult> {
  return {
    name: 'ACP initialize handshake',
    status: 'skipped',
    command: 'bun run scripts/probe-copilot-acp.ts',
    evidence: `ACP initialize requires persistent NDJSON JSON-RPC; use scripts/probe-copilot-acp.ts for trusted ACP evidence. copilotPath=${copilotPath}`,
  };
}

async function probeProcessCancellation(copilotPath: string): Promise<IProbeResult> {
  const proc = Bun.spawn(
    [
      copilotPath,
      '--no-color',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--log-level',
      'error',
      '--prompt',
      'Wait briefly, then reply with VOLARE_CANCEL_PROBE_DONE.',
    ],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...Bun.env,
        NO_COLOR: '1',
        CI: '1',
      },
    },
  );

  await Bun.sleep(1_000);
  proc.kill('SIGTERM');
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    streamToText(proc.stdout),
    streamToText(proc.stderr),
  ]);

  return {
    name: 'process-level cancellation',
    status: exitCode === 143 || exitCode === null || exitCode === 0 ? 'supported' : 'unknown',
    command: 'start copilot --prompt, then SIGTERM',
    evidence: `exitCode=${exitCode}; ${summarize({ exitCode, stdout, stderr, timedOut: false })}`,
  };
}

async function main(): Promise<void> {
  const copilotPath = await findCommand('copilot');
  const results: IProbeResult[] = [];

  if (!copilotPath) {
    results.push({
      name: 'copilot executable',
      status: 'unsupported',
      evidence: '`copilot` was not found on PATH',
    });
  } else {
    results.push(await probeVersion(copilotPath));
    results.push(await probeHelp(copilotPath));
    results.push(await probeAcpStartup(copilotPath));
    results.push(await probeAcpInitialize(copilotPath));
    results.push(await probeNonInteractivePrompt(copilotPath));
    results.push(await probeStreamingPrompt(copilotPath));
    results.push(await probeProcessCancellation(copilotPath));
  }

  const helpResult = results.find((result) => result.name === 'cli capability flags');
  const promptResult = results.find(
    (result) => result.name === 'session creation, prompt send, and text response',
  );
  const permissionRequests = helpResult?.evidence.includes('permissionFlags=true') ?? false;
  const externalApprovalDecisions = false;
  const backendInternalPauseResume = promptResult?.status === 'supported' && permissionRequests;

  const report: IProbeReport = {
    generatedAt: new Date().toISOString(),
    workspace: process.cwd(),
    copilotPath,
    results,
    approvalCapabilityMetadata: {
      permissionRequests,
      externalApprovalDecisions,
      backendInternalPauseResume,
      decision: externalApprovalDecisions
        ? 'external-decisions'
        : backendInternalPauseResume
          ? 'backend-internal-pause-resume'
          : 'unsupported',
      reason: backendInternalPauseResume
        ? 'CLI exposes permission controls and prompt execution works, but ACP external approval decision delivery was not proven.'
        : 'Probe did not prove a backend approval pause/resume path.',
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

await main();
