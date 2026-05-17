import { describe, expect, test } from 'bun:test';

import { scanRawGroundingSignals } from '../../../src/core/grounding';

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
