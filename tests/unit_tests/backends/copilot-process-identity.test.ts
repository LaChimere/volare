import { describe, expect, test } from 'bun:test';

import {
  createProcessIdentity,
  DefaultProcessIdentityValidator,
} from '../../../src/backends/copilot-cli/process-identity';

describe('DefaultProcessIdentityValidator', () => {
  test('accepts matching process identity metadata', () => {
    const validator = new DefaultProcessIdentityValidator();
    const identity = createProcessIdentity('1234', 1000);

    expect(() => validator.assertMatches(identity, '1234')).not.toThrow();
  });

  test('rejects PID mismatch and reused PID metadata', () => {
    const validator = new DefaultProcessIdentityValidator();
    const identity = createProcessIdentity('1234', 1000);

    expect(() => validator.assertMatches(identity, '5678')).toThrow(
      'Process identity did not match',
    );
    expect(() =>
      validator.assertMatches(
        {
          ...identity,
          processStartedAt: 2000,
        },
        '1234',
      ),
    ).toThrow('Process identity did not match');
  });
});
