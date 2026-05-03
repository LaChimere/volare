import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentLoomError } from '../../../src/core/errors';
import { WorkspaceResolver } from '../../../src/core/workspace-resolver';

describe('WorkspaceResolver', () => {
  test('canonicalizes the configured workspace root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-loom-workspace-'));
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
    const defaultRoot = await mkdtemp(path.join(tmpdir(), 'agent-loom-default-'));
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

  test('uses explicit client metadata instead of the projectless workspace', async () => {
    const requestedRoot = await mkdtemp(path.join(tmpdir(), 'agent-loom-requested-'));
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

  test('rejects requested roots outside the allowlist', async () => {
    const allowed = await mkdtemp(path.join(tmpdir(), 'agent-loom-allowed-'));
    const forbidden = await mkdtemp(path.join(tmpdir(), 'agent-loom-forbidden-'));
    const resolver = new WorkspaceResolver();
    try {
      await expect(
        resolver.resolve(
          { source: 'client-metadata', requestedRoot: forbidden },
          { allowedWorkspaceRoots: [allowed] },
        ),
      ).rejects.toMatchObject({
        code: 'workspace_forbidden',
      } satisfies Partial<AgentLoomError>);
    } finally {
      await rm(allowed, { recursive: true, force: true });
      await rm(forbidden, { recursive: true, force: true });
    }
  });
});
