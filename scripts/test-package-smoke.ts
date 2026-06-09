import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

async function run(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${[command, ...args].join(' ')}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
        stdout.trim() ? `stdout: ${stdout.trim()}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    );
  }
  return stdout;
}

let packedPackage: string | undefined;
let smokeDir: string | undefined;
let buildOutputBackup: Buffer | undefined;
let buildOutputExisted = false;
let buildsDirExisted = false;

try {
  buildsDirExisted = await exists('builds');
  buildOutputExisted = await exists('builds/volare');
  if (buildOutputExisted) {
    buildOutputBackup = await readFile('builds/volare');
  }
  await run('bun', ['run', 'package']);
  await run('./builds/volare', ['help']);
  await run('npm', ['pack', '--dry-run']);
  packedPackage = (await run('npm', ['pack', '--silent'])).trim().split(/\r?\n/).at(-1);
  if (!packedPackage) {
    throw new Error('npm pack did not report a tarball path');
  }
  const packedName = basename(packedPackage);
  smokeDir = await mkdtemp(join(tmpdir(), 'volare-package-smoke-'));
  await copyFile(packedPackage, join(smokeDir, packedName));
  await run('bun', ['install', `./${packedName}`], { cwd: smokeDir });
  await run('bunx', ['--bun', 'volare', 'help'], { cwd: smokeDir });
} finally {
  if (buildOutputExisted && buildOutputBackup) {
    await writeFile('builds/volare', buildOutputBackup);
  } else {
    await rm('builds/volare', { force: true });
  }
  if (!buildsDirExisted) {
    await rm('builds', { recursive: true, force: true });
  }
  if (packedPackage) {
    await rm(packedPackage, { force: true });
  }
  if (smokeDir) {
    await rm(smokeDir, { recursive: true, force: true });
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
