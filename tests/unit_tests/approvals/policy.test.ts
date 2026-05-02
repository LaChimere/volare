import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DefaultApprovalPolicy,
  normalizePermissionRequestScope,
} from '../../../src/approvals/policy';
import type { ApprovalContextInterface, PermissionRequestInterface } from '../../../src/core/types';

async function withWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(import.meta.dir, 'approval-workspace-'));
  try {
    return await run(await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(workspaceRootPath: string): ApprovalContextInterface {
  return {
    turnId: 'turn_1',
    threadId: 'thread_1',
    workspaceId: 'workspace_1',
    workspaceRootPath,
  };
}

function request(action: string, filePath?: string): PermissionRequestInterface {
  return {
    action,
    scope: filePath ? { path: filePath } : {},
  };
}

describe('DefaultApprovalPolicy', () => {
  test('allows read-only filesystem requests after canonicalizing paths', async () => {
    await withWorkspace(async (root) => {
      const filePath = path.join(root, 'README.md');
      await writeFile(filePath, 'hello');

      await expect(
        new DefaultApprovalPolicy().evaluate(
          request('filesystem:read', 'README.md'),
          context(root),
        ),
      ).resolves.toMatchObject({
        type: 'allow',
        request: { scope: { path: filePath } },
      });
    });
  });

  test('asks for writes and shell by default', async () => {
    await withWorkspace(async (root) => {
      const filePath = path.join(root, 'editable.txt');
      await writeFile(filePath, 'hello');
      const policy = new DefaultApprovalPolicy({ now: () => 1000, timeoutMs: 5000 });

      await expect(
        policy.evaluate(request('filesystem:write', filePath), context(root)),
      ).resolves.toMatchObject({
        type: 'ask',
        timeoutAt: 6000,
      });
      await expect(policy.evaluate(request('shell:exec'), context(root))).resolves.toMatchObject({
        type: 'ask',
        timeoutAt: 6000,
      });
    });
  });

  test('denies destructive actions by default', async () => {
    await withWorkspace(async (root) => {
      await expect(
        new DefaultApprovalPolicy().evaluate(request('destructive'), context(root)),
      ).resolves.toMatchObject({
        type: 'deny',
        reason: 'destructive_action_denied',
      });
    });
  });

  test('denies paths outside the workspace and canonicalization failures', async () => {
    await withWorkspace(async (root) => {
      const outsideRoot = await mkdtemp(path.join(import.meta.dir, 'approval-outside-'));
      try {
        const outsideFile = path.join(outsideRoot, 'secret.txt');
        await writeFile(outsideFile, 'secret');
        await mkdir(path.join(root, 'nested'));
        await symlink(outsideFile, path.join(root, 'nested', 'link.txt'));

        await expect(
          normalizePermissionRequestScope(request('filesystem:read', 'nested/link.txt'), root),
        ).resolves.toEqual({
          type: 'deny',
          reason: 'path_outside_workspace',
        });
        await expect(
          normalizePermissionRequestScope(request('filesystem:read', 'missing.txt'), root),
        ).resolves.toEqual({
          type: 'deny',
          reason: 'path_canonicalization_failed',
        });
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  });
});
