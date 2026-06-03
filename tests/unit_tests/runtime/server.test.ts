import { describe, expect, test } from 'bun:test';

import { AcpCopilotPromptRunner } from '../../../src/backends/copilot-cli/acp-runner';
import { BunCopilotPromptRunner } from '../../../src/backends/copilot-cli/backend';
import { NoopLogger } from '../../../src/logging/logger';
import { createCopilotPromptRunner } from '../../../src/runtime/server';
import { createServerRuntimeConfig } from '../../../src/server/config';

describe('runtime server wiring', () => {
  test('keeps process runner as the default', () => {
    const config = createServerRuntimeConfig({});

    expect(createCopilotPromptRunner(config, new NoopLogger())).toBeInstanceOf(
      BunCopilotPromptRunner,
    );
  });

  test('creates ACP runner only when explicitly configured', () => {
    const config = createServerRuntimeConfig({
      VOLARE_COPILOT_RUNTIME_MODE: 'acp',
      VOLARE_COPILOT_ACP_MAX_WORKERS: '2',
      VOLARE_MAX_ACTIVE_SESSIONS: '3',
    });

    expect(createCopilotPromptRunner(config, new NoopLogger())).toBeInstanceOf(
      AcpCopilotPromptRunner,
    );
  });
});
