import { describe, expect, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentLoomError } from '../../../src/core/errors';
import { WorkspaceResolver } from '../../../src/core/workspace-resolver';

describe('WorkspaceResolver', () => {
  test('canonicalizes the configured workspace root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-loom-workspace-'));
    const resolver = new WorkspaceResolver();

    const workspace = await resolver.resolve(
      { source: 'server-config' },
      { defaultWorkspaceRoot: root },
    );

    expect(workspace.rootPath).toBe(await realpath(root));
    expect(workspace.id.startsWith('workspace_')).toBe(true);
  });

  test('rejects requested roots outside the allowlist', async () => {
    const allowed = await mkdtemp(path.join(tmpdir(), 'agent-loom-allowed-'));
    const forbidden = await mkdtemp(path.join(tmpdir(), 'agent-loom-forbidden-'));
    const resolver = new WorkspaceResolver();

    await expect(
      resolver.resolve(
        { source: 'client-metadata', requestedRoot: forbidden },
        { allowedWorkspaceRoots: [allowed] },
      ),
    ).rejects.toMatchObject({
      code: 'workspace_forbidden',
    } satisfies Partial<AgentLoomError>);
  });
});
