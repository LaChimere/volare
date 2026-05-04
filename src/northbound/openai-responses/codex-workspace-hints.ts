import path from 'node:path';
import type { INorthboundRequest, IWorkspaceHints } from '../../core/types';

export function codexWorkspaceHintsFromRequest(
  request: INorthboundRequest,
  metadata: Record<string, unknown> | undefined,
): IWorkspaceHints | undefined {
  const environmentContextRoot = workspaceRootFromCodexEnvironmentContext(request.body, metadata);
  if (environmentContextRoot) {
    return { source: 'client-context', requestedRoot: environmentContextRoot };
  }
  const startupContextRoot = workspaceRootFromCodexStartupContext(request.body, metadata);
  if (startupContextRoot) {
    return { source: 'client-context', requestedRoot: startupContextRoot };
  }
  const turnMetadataRoot = workspaceRootFromCodexTurnMetadata(request, metadata);
  if (turnMetadataRoot) {
    return { source: 'request-header', requestedRoot: turnMetadataRoot };
  }
  return undefined;
}

function workspaceRootFromCodexTurnMetadata(
  request: INorthboundRequest,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const headerValue =
    request.headers?.get('x-codex-turn-metadata') ??
    stringValue(metadata?.['x-codex-turn-metadata']);
  if (!headerValue) {
    return undefined;
  }
  const parsed = parseJsonRecord(headerValue);
  const workspaces = isRecord(parsed?.['workspaces']) ? parsed['workspaces'] : undefined;
  if (!workspaces) {
    return undefined;
  }
  const workspaceRoots = Object.keys(workspaces)
    .map(safeAbsolutePath)
    .filter((value): value is string => value !== undefined);
  return workspaceRoots.length === 1 ? workspaceRoots[0] : undefined;
}

function workspaceRootFromCodexEnvironmentContext(
  body: unknown,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!isCodexRequest(metadata)) {
    return undefined;
  }
  for (const text of textPartsFromRequestBody(body)) {
    const workspaceRoot = workspaceRootFromEnvironmentContextText(text);
    if (workspaceRoot) {
      return workspaceRoot;
    }
  }
  return undefined;
}

function workspaceRootFromCodexStartupContext(
  body: unknown,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!isCodexRequest(metadata)) {
    return undefined;
  }
  for (const text of textPartsFromRequestBody(body)) {
    const workspaceRoot = workspaceRootFromStartupContextText(text);
    if (workspaceRoot) {
      return workspaceRoot;
    }
  }
  return undefined;
}

function isCodexRequest(metadata: Record<string, unknown> | undefined): boolean {
  return Boolean(metadata?.['x-codex-installation-id']);
}

function workspaceRootFromEnvironmentContextText(text: string): string | undefined {
  const match = text.match(/<environment_context>\s*([\s\S]*?)\s*<\/environment_context>/);
  const context = match?.[1];
  if (!context) {
    return undefined;
  }
  const localEnvironmentMatch = context.match(
    /<environment\s+id="local">([\s\S]*?)<\/environment>/,
  );
  if (localEnvironmentMatch) {
    return safeAbsolutePath(localEnvironmentMatch[1]?.match(/<cwd>\s*([^<]+?)\s*<\/cwd>/)?.[1]);
  }
  const cwdMatch = context.match(/<cwd>\s*([^<]+?)\s*<\/cwd>/);
  return safeAbsolutePath(cwdMatch?.[1]);
}

function workspaceRootFromStartupContextText(text: string): string | undefined {
  const match = text.match(/<startup_context>\s*([\s\S]*?)\s*<\/startup_context>/);
  const context = match?.[1];
  if (!context?.startsWith('Startup context from Codex.')) {
    return undefined;
  }
  const cwdMatch = context.match(/^Current working directory:\s*(.+)$/m);
  return safeAbsolutePath(cwdMatch?.[1]);
}

function textPartsFromRequestBody(body: unknown): string[] {
  if (!isRecord(body)) {
    return [];
  }
  const parts: string[] = [];
  const instructions = stringValue(body['instructions']);
  if (instructions) {
    parts.push(instructions);
  }
  collectInputTextParts(body['input'], parts);
  return parts;
}

function collectInputTextParts(input: unknown, parts: string[]): void {
  const inputText = stringValue(input);
  if (inputText) {
    parts.push(inputText);
    return;
  }
  if (!Array.isArray(input)) {
    return;
  }
  for (const item of input) {
    const itemText = stringValue(item);
    if (itemText) {
      parts.push(itemText);
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    collectContentTextParts(item['content'], parts);
  }
}

function collectContentTextParts(content: unknown, parts: string[]): void {
  const contentText = stringValue(content);
  if (contentText) {
    parts.push(contentText);
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }
  for (const part of content) {
    const partText = stringValue(part);
    if (partText) {
      parts.push(partText);
      continue;
    }
    if (isRecord(part)) {
      const text = stringValue(part['text']);
      if (text) {
        parts.push(text);
      }
    }
  }
}

function safeAbsolutePath(value: unknown): string | undefined {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || hasControlCharacter(candidate)) {
    return undefined;
  }
  return path.isAbsolute(candidate) ? candidate : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
