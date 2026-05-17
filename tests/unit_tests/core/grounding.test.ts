import { describe, expect, test } from 'bun:test';

import {
  classifyRequestGrounding,
  evaluateAnswerGrounding,
  scanRawGroundingSignals,
} from '../../../src/core/grounding';

const MAX_EVALUATED_BYTES = 256 * 1024;

describe('scanRawGroundingSignals', () => {
  test('counts citation-like markdown links, bare URLs, and bracket references', () => {
    expect(
      scanRawGroundingSignals(
        'See [Reuters](https://example.test/a), https://example.test/b, and [12].',
      ),
    ).toMatchObject({
      markdownHttpLinkCount: 1,
      bareHttpUrlCount: 1,
      bracketReferenceCount: 1,
      citationLikeOutputCount: 3,
      truncated: false,
    });
  });

  test('does not double-count markdown link URLs with whitespace as bare URLs', () => {
    expect(scanRawGroundingSignals('[Reuters]( https://example.test/a )')).toMatchObject({
      markdownHttpLinkCount: 1,
      bareHttpUrlCount: 0,
      citationLikeOutputCount: 1,
    });
  });

  test('evaluates exactly 256 KiB without truncation', () => {
    const prefix = 'x'.repeat(MAX_EVALUATED_BYTES - ' [1]'.length);
    const scan = scanRawGroundingSignals(`${prefix} [1]`);

    expect(scan).toMatchObject({
      bracketReferenceCount: 1,
      citationLikeOutputCount: 1,
      evaluatedByteCount: MAX_EVALUATED_BYTES,
      truncated: false,
    });
  });

  test('truncates 256 KiB plus one byte before scanning', () => {
    const prefix = 'x'.repeat(MAX_EVALUATED_BYTES);
    const scan = scanRawGroundingSignals(`${prefix}[1]`);

    expect(scan).toMatchObject({
      bracketReferenceCount: 0,
      citationLikeOutputCount: 0,
      evaluatedByteCount: MAX_EVALUATED_BYTES,
      truncated: true,
    });
  });

  test('handles a multibyte UTF-8 sequence crossing the byte boundary', () => {
    const prefix = 'x'.repeat(MAX_EVALUATED_BYTES - 2);
    const scan = scanRawGroundingSignals(`${prefix}€[1]`);

    expect(scan).toMatchObject({
      bracketReferenceCount: 0,
      citationLikeOutputCount: 0,
      evaluatedByteCount: MAX_EVALUATED_BYTES,
      truncated: true,
    });
  });
});

describe('classifyRequestGrounding', () => {
  test('classifies code requests without source grounding', () => {
    expect(classifyRequestGrounding({ message: 'Debug this TypeScript build error' })).toEqual({
      domain: 'code',
      needsSourceGrounding: false,
    });
  });

  test('classifies English current/search prompts as external research', () => {
    expect(
      classifyRequestGrounding({ message: 'Search recent public filings and cite sources' }),
    ).toEqual({
      domain: 'external_research',
      needsSourceGrounding: true,
    });
  });

  test('classifies Chinese external factual prompts as external research', () => {
    for (const message of ['搜索最近新闻', '最新披露有哪些', '请给出处和来源']) {
      expect(classifyRequestGrounding({ message })).toEqual({
        domain: 'external_research',
        needsSourceGrounding: true,
      });
    }
  });

  test('chooses external research for mixed prompts', () => {
    expect(
      classifyRequestGrounding({
        message: 'Fix this parser and compare recent public filings afterward',
      }),
    ).toEqual({
      domain: 'external_research',
      needsSourceGrounding: true,
    });
  });

  test('falls back to general when no conservative trigger matches', () => {
    expect(classifyRequestGrounding({ message: 'Explain why concise writing helps' })).toEqual({
      domain: 'general',
      needsSourceGrounding: false,
    });
  });

  test('does not classify URL hostnames as code requests', () => {
    expect(classifyRequestGrounding({ message: 'see https://example.test/report [1]' })).toEqual({
      domain: 'general',
      needsSourceGrounding: false,
    });
  });
});

describe('evaluateAnswerGrounding', () => {
  test('warns when an external research answer has no sources', () => {
    expect(
      evaluateAnswerGrounding({
        outputText: 'No citations here',
        hint: { domain: 'external_research', needsSourceGrounding: true },
        sourceCount: 0,
        toolObservedCount: 0,
        unmediatedToolingEnabled: false,
      }),
    ).toMatchObject({
      domain: 'external_research',
      needsSourceGrounding: true,
      citationLikeOutputCount: 0,
      sourceCount: 0,
      toolObservedCount: 0,
      unmediatedToolingEnabled: false,
      warningCodes: ['NEEDS_SOURCES_NO_SOURCES'],
    });
  });

  test('warns when citation-like text appears without sources for non-external prompts', () => {
    expect(
      evaluateAnswerGrounding({
        outputText: 'See https://example.test/report and [1].',
        hint: { domain: 'general', needsSourceGrounding: false },
        sourceCount: 0,
        toolObservedCount: 0,
        unmediatedToolingEnabled: false,
      }),
    ).toMatchObject({
      citationLikeOutputCount: 2,
      warningCodes: ['CITATION_LIKE_TEXT_WITHOUT_SOURCES'],
    });
  });

  test('warns when unmediated tooling is enabled', () => {
    expect(
      evaluateAnswerGrounding({
        outputText: '',
        hint: { domain: 'code', needsSourceGrounding: false },
        sourceCount: 0,
        toolObservedCount: 1,
        unmediatedToolingEnabled: true,
      }).warningCodes,
    ).toEqual(['UNMEDIATED_TOOLING_ENABLED']);
  });

  test('does not warn on citation-like text for code prompts', () => {
    expect(
      evaluateAnswerGrounding({
        outputText: 'Patch src/index.ts and run [1] test.',
        hint: { domain: 'code', needsSourceGrounding: false },
        sourceCount: 0,
        toolObservedCount: 0,
        unmediatedToolingEnabled: false,
      }).warningCodes,
    ).toEqual([]);
  });

  test('preserves scanner byte truncation fields', () => {
    const scan = evaluateAnswerGrounding({
      outputText: `${'x'.repeat(MAX_EVALUATED_BYTES)}[1]`,
      hint: { domain: 'general', needsSourceGrounding: false },
      sourceCount: 0,
      toolObservedCount: 0,
      unmediatedToolingEnabled: false,
    });

    expect(scan).toMatchObject({
      evaluatedByteCount: MAX_EVALUATED_BYTES,
      truncated: true,
      citationLikeOutputCount: 0,
      warningCodes: [],
    });
  });
});
