import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { type ILogger, NoopLogger } from '../logging/logger';
import { AgentLoomError } from './errors';
import type { IServerConfig, IWorkspace, IWorkspaceHints, IWorkspaceResolver } from './types';

export interface IWorkspaceResolverOptions {
  logger?: ILogger;
}

export class WorkspaceResolver implements IWorkspaceResolver {
  readonly #logger: ILogger;

  constructor(options: IWorkspaceResolverOptions = {}) {
    this.#logger = (options.logger ?? new NoopLogger()).child({ component: 'workspace-resolver' });
  }

  async resolve(hints: IWorkspaceHints, config: IServerConfig): Promise<IWorkspace> {
    const projectless =
      !hints.requestedRoot &&
      (hints.source === 'process-cwd' || hints.source === 'projectless') &&
      config.projectlessWorkspaceRoot !== undefined;
    const requestedRoot =
      hints.requestedRoot ??
      (projectless ? config.projectlessWorkspaceRoot : undefined) ??
      config.defaultWorkspaceRoot ??
      process.cwd();
    const rootPath = await this.#canonicalize(requestedRoot, { createIfMissing: projectless });
    const allowedRoots = await Promise.all(
      allowedRootCandidates(config).map((root) =>
        this.#canonicalize(root, { createIfMissing: root === config.projectlessWorkspaceRoot }),
      ),
    );

    if (!allowedRoots.some((allowedRoot) => isInsideOrEqual(rootPath, allowedRoot))) {
      this.#logger.warn(
        {
          event: 'workspace.resolve.forbidden',
          workspaceKey: `workspace_${hashPath(rootPath)}`,
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
        workspaceKey: `workspace_${hashPath(rootPath)}`,
        requestedRootSource: sourceForRequestedRoot(hints, config),
        projectless,
        allowedRootCount: allowedRoots.length,
      },
      'workspace resolved',
    );
    return {
      id: `workspace_${hashPath(rootPath)}`,
      rootPath,
    };
  }

  async #canonicalize(root: string, options: { createIfMissing?: boolean } = {}): Promise<string> {
    try {
      const resolved = path.resolve(root);
      if (options.createIfMissing) {
        await mkdir(resolved, { recursive: true });
      }
      return await realpath(resolved);
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
  hints: IWorkspaceHints,
  config: IServerConfig,
): 'request' | 'projectless' | 'config' | 'cwd' {
  if (hints.requestedRoot) {
    return 'request';
  }
  if (
    (hints.source === 'process-cwd' || hints.source === 'projectless') &&
    config.projectlessWorkspaceRoot
  ) {
    return 'projectless';
  }
  if (config.defaultWorkspaceRoot) {
    return 'config';
  }
  return 'cwd';
}

function allowedRootCandidates(config: IServerConfig): string[] {
  if (config.allowedWorkspaceRoots) {
    return config.projectlessWorkspaceRoot
      ? [...config.allowedWorkspaceRoots, config.projectlessWorkspaceRoot]
      : config.allowedWorkspaceRoots;
  }
  return [
    config.defaultWorkspaceRoot ?? process.cwd(),
    ...(config.projectlessWorkspaceRoot ? [config.projectlessWorkspaceRoot] : []),
  ];
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
