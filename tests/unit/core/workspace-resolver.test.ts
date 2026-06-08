import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { VolareError } from '../../../src/core/errors';
import { WorkspaceResolver } from '../../../src/core/workspace-resolver';

describe('WorkspaceResolver', () => {
  test('canonicalizes the configured workspace root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'volare-workspace-'));
    const resolver = new WorkspaceResolver();
    try {
      const workspace = await resolver.resolve(
        { source: 'server-config' },
        { defaultWorkspaceRoot: root },
      );

      expect(workspace.rootPath).toBe(await realpath(root));
      expect(workspace.id.startsWith('workspace_')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses an isolated projectless workspace for process-cwd requests', async () => {
    const defaultRoot = await mkdtemp(path.join(tmpdir(), 'volare-default-'));
    const projectlessRoot = path.join(
      await mkdtemp(path.join(tmpdir(), 'neutralctx-')),
      'workspace',
    );
    const resolver = new WorkspaceResolver();
    try {
      const workspace = await resolver.resolve(
        { source: 'process-cwd' },
        { defaultWorkspaceRoot: defaultRoot, projectlessWorkspaceRoot: projectlessRoot },
      );

      expect(workspace.rootPath).toBe(await realpath(projectlessRoot));
      expect(workspace.rootPath).not.toBe(await realpath(defaultRoot));
    } finally {
      await rm(defaultRoot, { recursive: true, force: true });
      await rm(path.dirname(projectlessRoot), { recursive: true, force: true });
    }
  });

  test('allows projectless workspace when an allowlist is configured', async () => {
    const allowedRoot = await mkdtemp(path.join(tmpdir(), 'volare-allowed-'));
    const projectlessRoot = path.join(
      await mkdtemp(path.join(tmpdir(), 'neutralctx-')),
      'workspace',
    );
    const resolver = new WorkspaceResolver();
    try {
      const workspace = await resolver.resolve(
        { source: 'process-cwd' },
        { allowedWorkspaceRoots: [allowedRoot], projectlessWorkspaceRoot: projectlessRoot },
      );

      expect(workspace.rootPath).toBe(await realpath(projectlessRoot));
    } finally {
      await rm(allowedRoot, { recursive: true, force: true });
      await rm(path.dirname(projectlessRoot), { recursive: true, force: true });
    }
  });

  test('uses explicit client metadata instead of the projectless workspace', async () => {
    const requestedRoot = await mkdtemp(path.join(tmpdir(), 'volare-requested-'));
    const projectlessRoot = path.join(
      await mkdtemp(path.join(tmpdir(), 'neutralctx-')),
      'workspace',
    );
    const resolver = new WorkspaceResolver();
    try {
      const workspace = await resolver.resolve(
        { source: 'client-metadata', requestedRoot },
        { allowedWorkspaceRoots: [requestedRoot], projectlessWorkspaceRoot: projectlessRoot },
      );

      expect(workspace.rootPath).toBe(await realpath(requestedRoot));
    } finally {
      await rm(requestedRoot, { recursive: true, force: true });
      await rm(path.dirname(projectlessRoot), { recursive: true, force: true });
    }
  });

  test('permits explicit requested roots when no allowlist is configured', async () => {
    const defaultRoot = await mkdtemp(path.join(tmpdir(), 'volare-default-'));
    const requestedRoot = await mkdtemp(path.join(tmpdir(), 'volare-requested-'));
    const resolver = new WorkspaceResolver();
    try {
      const workspace = await resolver.resolve(
        { source: 'client-context', requestedRoot },
        { defaultWorkspaceRoot: defaultRoot },
      );

      expect(workspace.rootPath).toBe(await realpath(requestedRoot));
    } finally {
      await rm(defaultRoot, { recursive: true, force: true });
      await rm(requestedRoot, { recursive: true, force: true });
    }
  });

  test('warns when explicit roots are accepted without an allowlist', async () => {
    const defaultRoot = await mkdtemp(path.join(tmpdir(), 'volare-default-'));
    const requestedRoot = await mkdtemp(path.join(tmpdir(), 'volare-requested-'));
    const logger = new CapturingLogger();
    const resolver = new WorkspaceResolver({ logger });
    try {
      await resolver.resolve(
        { source: 'client-context', requestedRoot },
        { defaultWorkspaceRoot: defaultRoot },
      );

      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          fields: expect.objectContaining({
            event: 'workspace.resolve.permissive',
            requestedRootSource: 'request',
          }),
        }),
      );
    } finally {
      await rm(defaultRoot, { recursive: true, force: true });
      await rm(requestedRoot, { recursive: true, force: true });
    }
  });

  test('rejects requested roots outside the allowlist', async () => {
    const allowed = await mkdtemp(path.join(tmpdir(), 'volare-allowed-'));
    const forbidden = await mkdtemp(path.join(tmpdir(), 'volare-forbidden-'));
    const resolver = new WorkspaceResolver();
    try {
      await expect(
        resolver.resolve(
          { source: 'client-metadata', requestedRoot: forbidden },
          { allowedWorkspaceRoots: [allowed] },
        ),
      ).rejects.toMatchObject({
        code: 'workspace_forbidden',
      } satisfies Partial<VolareError>);
    } finally {
      await rm(allowed, { recursive: true, force: true });
      await rm(forbidden, { recursive: true, force: true });
    }
  });
});

class CapturingLogger {
  readonly entries: Array<{ level: string; fields: Record<string, unknown>; message?: string }> =
    [];

  child(): CapturingLogger {
    return this;
  }

  trace(fields: Record<string, unknown>, message?: string): void {
    this.push('trace', fields, message);
  }

  debug(fields: Record<string, unknown>, message?: string): void {
    this.push('debug', fields, message);
  }

  info(fields: Record<string, unknown>, message?: string): void {
    this.push('info', fields, message);
  }

  warn(fields: Record<string, unknown>, message?: string): void {
    this.push('warn', fields, message);
  }

  error(fields: Record<string, unknown>, message?: string): void {
    this.push('error', fields, message);
  }

  fatal(fields: Record<string, unknown>, message?: string): void {
    this.push('fatal', fields, message);
  }

  private push(level: string, fields: Record<string, unknown>, message?: string): void {
    this.entries.push({ level, fields, ...(message ? { message } : {}) });
  }
}
