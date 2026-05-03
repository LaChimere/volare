import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { type LoggerInterface, NoopLogger } from '../logging/logger';
import { AgentLoomError } from './errors';
import type {
  ServerConfigInterface,
  WorkspaceHintsInterface,
  WorkspaceInterface,
  WorkspaceResolverInterface,
} from './types';

export interface WorkspaceResolverOptionsInterface {
  logger?: LoggerInterface;
}

export class WorkspaceResolver implements WorkspaceResolverInterface {
  readonly #logger: LoggerInterface;

  constructor(options: WorkspaceResolverOptionsInterface = {}) {
    this.#logger = (options.logger ?? new NoopLogger()).child({ component: 'workspace-resolver' });
  }

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
      this.#logger.warn(
        {
          event: 'workspace.resolve.forbidden',
          workspaceId: `workspace_${hashPath(rootPath)}`,
          requestedRootSource: sourceForRequestedRoot(hints, config),
          allowedRootCount: allowedRoots.length,
        },
        'workspace root is outside allowed roots',
      );
      throw new AgentLoomError(
        'workspace_forbidden',
        'Workspace root is outside the allowed roots',
      );
    }

    this.#logger.info(
      {
        event: 'workspace.resolved',
        workspaceId: `workspace_${hashPath(rootPath)}`,
        requestedRootSource: sourceForRequestedRoot(hints, config),
        allowedRootCount: allowedRoots.length,
      },
      'workspace resolved',
    );
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

function sourceForRequestedRoot(
  hints: WorkspaceHintsInterface,
  config: ServerConfigInterface,
): 'request' | 'config' | 'cwd' {
  if (hints.requestedRoot) {
    return 'request';
  }
  if (config.defaultWorkspaceRoot) {
    return 'config';
  }
  return 'cwd';
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
