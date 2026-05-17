import type { IAgentInput } from './types';

const DEFAULT_MAX_EVALUATED_BYTES = 256 * 1024;
const MAX_MATCHES_PER_PATTERN = 10_000;

const markdownHttpLinkPattern = /\[[^\]\r\n]{1,512}\]\(\s*https?:\/\/[^\s)<>]{1,2048}\s*\)/gi;
const httpUrlPattern = /https?:\/\/[^\s<>"'`]+/gi;
const bracketReferencePattern = /\[\d{1,4}\]/g;
const externalResearchPattern =
  /\b(search|recent|latest|current|today|news|fetch|browse|source|sources|cite|citation|public\s+filings?)\b|搜索|最近|最新|披露|出处|来源|引用|浏览|抓取/i;
const codeRequestPattern =
  /\b(code|debug|build|test|typecheck|lint|compile|typescript|javascript|fix|bug|error|stack trace|repository|workspace)\b|代码|调试|构建|测试|报错|修复/i;

export type RequestDomainHint = 'code' | 'external_research' | 'general';

export interface IRequestGroundingHint {
  domain: RequestDomainHint;
  needsSourceGrounding: boolean;
}

export type GroundingWarningCode =
  | 'NEEDS_SOURCES_NO_SOURCES'
  | 'UNMEDIATED_TOOLING_ENABLED'
  | 'CITATION_LIKE_TEXT_WITHOUT_SOURCES';

export interface IAnswerGroundingSignals {
  domain: RequestDomainHint;
  needsSourceGrounding: boolean;
  citationLikeOutputCount: number;
  sourceCount: number;
  toolObservedCount: number;
  unmediatedToolingEnabled: boolean;
  evaluatedByteCount: number;
  truncated: boolean;
  warningCodes: GroundingWarningCode[];
}

export interface IEvaluateAnswerGroundingOptions {
  outputText?: string;
  hint: IRequestGroundingHint;
  sourceCount: number;
  toolObservedCount: number;
  unmediatedToolingEnabled: boolean;
}

export interface IRawGroundingScan {
  markdownHttpLinkCount: number;
  bareHttpUrlCount: number;
  bracketReferenceCount: number;
  citationLikeOutputCount: number;
  evaluatedByteCount: number;
  truncated: boolean;
}

export interface IRawGroundingScanOptions {
  maxEvaluatedBytes?: number;
}

export function scanRawGroundingSignals(
  outputText: string,
  options: IRawGroundingScanOptions = {},
): IRawGroundingScan {
  const maxEvaluatedBytes = options.maxEvaluatedBytes ?? DEFAULT_MAX_EVALUATED_BYTES;
  const { text, evaluatedByteCount, truncated } = utf8Prefix(outputText, maxEvaluatedBytes);
  const markdownHttpLinkCount = countMatches(markdownHttpLinkPattern, text);
  const bareHttpUrlCount = countMatches(
    httpUrlPattern,
    text,
    (match) => !isMarkdownLinkUrl(text, match.index),
  );
  const bracketReferenceCount = countMatches(bracketReferencePattern, text);
  return {
    markdownHttpLinkCount,
    bareHttpUrlCount,
    bracketReferenceCount,
    citationLikeOutputCount: markdownHttpLinkCount + bareHttpUrlCount + bracketReferenceCount,
    evaluatedByteCount,
    truncated,
  };
}

export function classifyRequestGrounding(input: IAgentInput): IRequestGroundingHint {
  const text = inputTextForClassification(input);
  if (externalResearchPattern.test(text)) {
    return { domain: 'external_research', needsSourceGrounding: true };
  }
  if (codeRequestPattern.test(text.replace(httpUrlPattern, ' '))) {
    return { domain: 'code', needsSourceGrounding: false };
  }
  return { domain: 'general', needsSourceGrounding: false };
}

export function evaluateAnswerGrounding(
  options: IEvaluateAnswerGroundingOptions,
): IAnswerGroundingSignals {
  const scan = scanRawGroundingSignals(options.outputText ?? '');
  const warningCodes: GroundingWarningCode[] = [];
  if (options.hint.needsSourceGrounding && options.sourceCount === 0) {
    warningCodes.push('NEEDS_SOURCES_NO_SOURCES');
  }
  if (
    !options.hint.needsSourceGrounding &&
    options.hint.domain !== 'code' &&
    options.sourceCount === 0 &&
    scan.citationLikeOutputCount > 0
  ) {
    warningCodes.push('CITATION_LIKE_TEXT_WITHOUT_SOURCES');
  }
  if (options.unmediatedToolingEnabled) {
    warningCodes.push('UNMEDIATED_TOOLING_ENABLED');
  }
  return {
    domain: options.hint.domain,
    needsSourceGrounding: options.hint.needsSourceGrounding,
    citationLikeOutputCount: scan.citationLikeOutputCount,
    sourceCount: options.sourceCount,
    toolObservedCount: options.toolObservedCount,
    unmediatedToolingEnabled: options.unmediatedToolingEnabled,
    evaluatedByteCount: scan.evaluatedByteCount,
    truncated: scan.truncated,
    warningCodes,
  };
}

function inputTextForClassification(input: IAgentInput): string {
  const parts = [
    input.systemInstructions,
    ...(input.conversationHistory ?? []).map((message) => message.content),
    input.message,
    ...(input.attachments ?? []).flatMap((attachment) => [attachment.name, attachment.uri]),
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.join('\n');
}

function utf8Prefix(
  value: string,
  maxBytes: number,
): { text: string; evaluatedByteCount: number; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) {
    return { text: value, evaluatedByteCount: bytes.byteLength, truncated: false };
  }
  return {
    text: new TextDecoder().decode(bytes.subarray(0, maxBytes)),
    evaluatedByteCount: maxBytes,
    truncated: true,
  };
}

function countMatches(
  pattern: RegExp,
  text: string,
  predicate: (match: RegExpExecArray) => boolean = () => true,
): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (count < MAX_MATCHES_PER_PATTERN) {
    const match = pattern.exec(text);
    if (!match) {
      break;
    }
    if (predicate(match)) {
      count += 1;
    }
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }
  return count;
}

function isMarkdownLinkUrl(text: string, urlIndex: number): boolean {
  let cursor = urlIndex - 1;
  while (cursor >= 0 && /\s/.test(text[cursor] ?? '')) {
    cursor -= 1;
  }
  if (cursor < 1 || text[cursor] !== '(') {
    return false;
  }
  return text[cursor - 1] === ']';
}
