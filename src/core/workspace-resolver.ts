import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { AgentLoomError } from './errors';
import type {
  ServerConfigInterface,
  WorkspaceHintsInterface,
  WorkspaceInterface,
  WorkspaceResolverInterface,
} from './types';

export class WorkspaceResolver implements WorkspaceResolverInterface {
  async resolve(
    hints: WorkspaceHintsInterface,
    config: ServerConfigInterface,
  ): Promise<WorkspaceInterface> {
    const requestedRoot = hints.requestedRoot ?? config.defaultWorkspaceRoot ?? process.cwd();
    const rootPath = await this.#canonicalize(requestedRoot);
    const allowedRoots = await Promise.all(
      (config.allowedWorkspaceRoots ?? [config.defaultWorkspaceRoot ?? process.cwd()]).map((root) =>
        this.#canonicalize(root),
      ),
    );

    if (!allowedRoots.some((allowedRoot) => isInsideOrEqual(rootPath, allowedRoot))) {
      throw new AgentLoomError(
        'workspace_forbidden',
        'Workspace root is outside the allowed roots',
      );
    }

    return {
      id: `workspace_${hashPath(rootPath)}`,
      rootPath,
    };
  }

  async #canonicalize(root: string): Promise<string> {
    try {
      return await realpath(path.resolve(root));
    } catch (cause) {
      throw new AgentLoomError(
        'workspace_canonicalization_failed',
        'Workspace root could not be resolved',
        {
          cause,
        },
      );
    }
  }
}

function isInsideOrEqual(candidate: string, allowedRoot: string): boolean {
  const relative = path.relative(allowedRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hashPath(rootPath: string): string {
  const bytes = new TextEncoder().encode(rootPath);
  let hash = 5381;
  for (const byte of bytes) {
    hash = (hash * 33) ^ byte;
  }
  return (hash >>> 0).toString(36);
}
