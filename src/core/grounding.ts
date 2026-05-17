const DEFAULT_MAX_EVALUATED_BYTES = 256 * 1024;
const MAX_MATCHES_PER_PATTERN = 10_000;

const markdownHttpLinkPattern = /\[[^\]\r\n]{1,512}\]\(\s*https?:\/\/[^\s)<>]{1,2048}\s*\)/gi;
const httpUrlPattern = /https?:\/\/[^\s<>"'`]+/gi;
const bracketReferencePattern = /\[\d{1,4}\]/g;

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
