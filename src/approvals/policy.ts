import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { createId } from '../core/ids';
import type {
  ApprovalEvaluation,
  IApprovalContext,
  IApprovalPolicy,
  IPermissionRequest,
} from '../core/types';

export type ApprovalPolicyMode = 'restricted' | 'ask' | 'allow-all';

export interface IApprovalPolicyOptions {
  mode?: ApprovalPolicyMode;
  timeoutMs?: number;
  now?: () => number;
}

export class DefaultApprovalPolicy implements IApprovalPolicy {
  readonly #mode: ApprovalPolicyMode;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(options: IApprovalPolicyOptions = {}) {
    this.#mode = options.mode ?? 'restricted';
    this.#timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  async evaluate(
    request: IPermissionRequest,
    context: IApprovalContext,
  ): Promise<ApprovalEvaluation> {
    const normalized = await normalizePermissionRequestScope(request, context.workspaceRootPath);
    if (normalized.type === 'deny') {
      return {
        type: 'deny',
        reason: normalized.reason,
        request,
      };
    }

    const normalizedRequest = normalized.request;
    if (this.#mode === 'allow-all') {
      return { type: 'allow', request: normalizedRequest };
    }

    if (isDestructive(normalizedRequest.action)) {
      return {
        type: 'deny',
        reason: 'destructive_action_denied',
        request: normalizedRequest,
      };
    }

    if (this.#mode === 'ask') {
      return this.#ask(normalizedRequest);
    }

    if (isReadOnlyFilesystem(normalizedRequest.action)) {
      return { type: 'allow', request: normalizedRequest };
    }
    if (isFilesystemWrite(normalizedRequest.action) || isShell(normalizedRequest.action)) {
      return this.#ask(normalizedRequest);
    }
    if (isNetwork(normalizedRequest.action)) {
      return {
        type: 'deny',
        reason: 'network_denied_by_default',
        request: normalizedRequest,
      };
    }

    return {
      type: 'deny',
      reason: 'unsupported_permission_action',
      request: normalizedRequest,
    };
  }

  #ask(request: IPermissionRequest): ApprovalEvaluation {
    return {
      type: 'ask',
      approvalId: createId('approval'),
      timeoutAt: this.#now() + this.#timeoutMs,
      request,
    };
  }
}

export async function normalizePermissionRequestScope(
  request: IPermissionRequest,
  workspaceRootPath: string,
): Promise<
  | { type: 'ok'; request: IPermissionRequest }
  | { type: 'deny'; reason: 'path_canonicalization_failed' | 'path_outside_workspace' }
> {
  if (!request.scope.path || !isFilesystemAction(request.action)) {
    return { type: 'ok', request };
  }

  try {
    const workspaceRoot = await realpath(workspaceRootPath);
    const requestedPath = path.isAbsolute(request.scope.path)
      ? request.scope.path
      : path.join(workspaceRoot, request.scope.path);
    const canonicalPath = await canonicalizePermissionPath(requestedPath, request.action);
    if (!isInsideOrEqual(canonicalPath, workspaceRoot)) {
      return { type: 'deny', reason: 'path_outside_workspace' };
    }
    return {
      type: 'ok',
      request: {
        ...request,
        scope: {
          ...request.scope,
          path: canonicalPath,
        },
      },
    };
  } catch {
    return { type: 'deny', reason: 'path_canonicalization_failed' };
  }
}

async function canonicalizePermissionPath(requestedPath: string, action: string): Promise<string> {
  try {
    return await realpath(requestedPath);
  } catch (cause) {
    if (action === 'filesystem:write' && isMissingPathError(cause)) {
      const canonicalParent = await realpath(path.dirname(requestedPath));
      return path.join(canonicalParent, path.basename(requestedPath));
    }
    throw cause;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isFilesystemAction(action: string): boolean {
  return action.startsWith('filesystem:');
}

function isReadOnlyFilesystem(action: string): boolean {
  return action === 'filesystem:read' || action === 'filesystem:list';
}

function isFilesystemWrite(action: string): boolean {
  return action === 'filesystem:write' || action === 'filesystem:delete';
}

function isShell(action: string): boolean {
  return action === 'shell:exec';
}

function isNetwork(action: string): boolean {
  return action.startsWith('network:');
}

function isDestructive(action: string): boolean {
  return action === 'destructive' || action.startsWith('destructive:');
}

function isInsideOrEqual(candidate: string, allowedRoot: string): boolean {
  const relative = path.relative(allowedRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
