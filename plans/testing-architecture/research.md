# Volare testing architecture research

## Executive summary

Two independent research passes converged on the same conclusion: Volare should evolve its tests from an organically grown collection into a **layered, contract-driven test architecture**. Comparable open-source agent/runtime, CLI, HTTP/SSE, durable-state, and security-sensitive projects rely on shared harnesses, fake backends, durable fixtures, golden wire contracts, and explicit CI lanes rather than ad hoc per-feature tests.[^opencode-harness][^vite-harness][^langgraph-durable][^openai-sse]

For Volare specifically, the current suite is already strong: it has unit/integration splits, fake backends, in-memory SQLite, durable restart simulation, Codex CLI E2E, stream/cancel/capacity/approval tests, capabilities privacy checks, and ACP worker/admission coverage. The next step should not be replacing Bun test; it should be consolidating repeated setup into `tests/support/`, adding file-backed durable-state and upcaster fixtures, expanding SSE wire-contract tests, and splitting CI into deterministic fast gates plus isolated real-Codex checks.

## Scope

This research answers:

- What do current high-quality open-source projects do for testing comparable systems?
- What practices apply to a stateful local agent-runtime bridge with HTTP/SSE, durable SQLite state, approvals, cancellation, ACP/Copilot workers, config editing, and real CLI integration?
- What should Volare's testing design look like?

The research synthesizes:

1. First-pass investigation into agent-runtime and JavaScript/TypeScript CLI testing.
2. A double-confirm pass across agent runtimes, HTTP/SSE projects, durable-state systems, security/privacy testing, and CI/flakiness practices.

## Comparable project findings

### Agent-runtime and coding assistant projects

OpenCode, Gemini CLI, Goose, Aider, Continue, and LangGraph show that agent runtimes need more than normal unit tests. They use scripted fake LLM/backends, isolated temp projects, test service graphs, fake MCP servers, session propagation checks, approval/cancellation matrices, and state/replay tests.[^opencode-harness][^gemini-fake-generator][^goose-mcp][^aider-temp-git][^langgraph-interrupt]

Relevant patterns:

- **Fake streaming backend/server**: OpenCode has a reusable fake LLM server capable of OpenAI-style SSE chunks, Responses events, hangs, stream errors, HTTP errors, connection resets, and tool calls.[^opencode-llm-server]
- **Scripted model/process behavior**: Gemini CLI's fake content generator supports non-streaming, streaming, token counting, embeddings, mixed call order, exhaustion errors, and fixture-file loading.[^gemini-fake-generator]
- **Approval/cancellation matrices**: Gemini CLI distinguishes soft rejection from hard abort and tests AbortSignal-triggered stream termination.[^gemini-cancel]
- **Durable/interruption semantics**: LangGraph tests interrupt/replay/checkpoint behavior across sync and async variants and durability modes.[^langgraph-interrupt][^langgraph-persistence]

### TypeScript CLI/server projects

Vite, Astro, React Router, Turborepo, pnpm, and Biome confirm that large local tooling projects should centralize fixture and process helpers. Their tests use temp project copies, configurable local servers, real CLI process runners, deterministic output normalization, snapshot redaction, and generated config fixtures.[^vite-harness][^astro-fixtures][^react-router-fixtures][^turborepo-snapshots][^pnpm-exec][^biome-snapshots]

Relevant patterns:

- **Local server harness**: Vite's playground setup starts dev/preview servers, captures logs, and exposes fixture-relative file helpers.[^vite-harness]
- **CLI process helper**: Astro and pnpm spawn real CLIs with controlled env, timeout, stdout/stderr capture, and fixture roots.[^astro-cli][^pnpm-exec]
- **Golden/snapshot redaction**: Biome normalizes time, executable names, temp/cache/config directories, and Windows path separators before snapshots.[^biome-snapshots]
- **Config mutation tests**: Turborepo copies named config variants into temp repos and snapshots stable CLI behavior.[^turborepo-config-tests]

### HTTP/SSE contract testing

OpenAI Node, eventsource-parser, vLLM, LiteLLM, sse-starlette, and LangGraph show that streaming protocols deserve byte-level and semantic contract tests. Good suites test split chunks, CRLF variants, comments, multi-line data, `[DONE]`, aborts, exact headers, stream errors, final state, and replay projections.[^openai-sse][^eventsource-parser][^vllm-streaming][^sse-starlette][^langgraph-streams]

Relevant patterns:

- Test the SSE parser from **`Uint8Array` chunks**, not only complete strings.[^openai-sse]
- Cover CRLF and boundary splits to avoid duplicate event emission.[^eventsource-parser]
- Compare streamed output with reconstructed semantic output.[^vllm-streaming]
- Assert exact SSE headers and cleanup on disconnect/send timeout.[^sse-starlette]

### Durable state, migrations, and replay

LangGraph checkpoint SQLite, Litestream, Prisma/Drizzle, Temporal, and event-sourcing samples point to a durable-state testing model: preserve old fixtures, replay them through current code, assert migrations/upcasters, simulate corruption and tombstones, and verify transaction rollback under injected failures.[^langgraph-durable][^litestream-wal][^prisma-migrations][^temporal-replay]

Relevant patterns:

- **Old persisted shapes through new code**: LangGraph migration tests write old checkpoint forms, then replay and continue with new code.[^langgraph-delta]
- **SQLite integrity under restore/restart**: Litestream validates restored DBs with `PRAGMA integrity_check` and semantic row checks.[^litestream-restore]
- **Golden histories**: Temporal replays old workflow histories and expects deterministic compatibility or explicit determinism failures.[^temporal-replay]

### Security and privacy testing

LiteLLM, Gemini CLI, Vite, OWASP guidance, and Volare's existing tests confirm that local developer tools should treat logs, metrics, debug output, capabilities, CLI stdout/stderr, and subprocess env as leak surfaces.[^litellm-redaction][^gemini-env][^vite-host][^owasp-cors]

Relevant patterns:

- Test realistic secret patterns: API keys, bearer tokens, provider keys, service-account JSON, PEM keys, JWT-like values, Slack/webhook/database URLs.[^litellm-redaction][^gemini-env]
- Test host/origin and filesystem allowlists explicitly, including unsafe host/origin forms and path boundary cases.[^vite-host][^vite-fs]
- Test redaction against nested structures, tracebacks, JSON logs, and ReDoS-like inputs.[^litellm-redaction][^gemini-redos]

### CI and flakiness practices

React Router, Astro, pnpm, Vite, Gemini CLI, and OpenCode split fast deterministic checks from slower browser/real CLI/downstream jobs. They use path filters, job-level timeouts, OS/runtime matrices, JUnit/artifacts, package smoke tests, and targeted quarantine rather than blanket retries.[^react-router-ci][^astro-ci][^pnpm-ci][^vite-ci][^gemini-ci][^opencode-ci]

Relevant patterns:

- PR fast lanes: lint/typecheck/unit/mock integration.
- Main/nightly/manual lanes: OS matrix, browser/real CLI, ecosystem checks, live probes.
- Artifacts: JUnit, logs, screenshots, temp fixture outputs, package tarballs.
- Flake management: targeted retries or quarantines, not full workflow reruns.

## Current Volare baseline

Volare already has important pieces of the desired architecture:

- `package.json` splits `check`, `test:unit`, `test:integration`, and `test`.
- Unit tests cover core runtime, approvals, backends, server app, northbound adapter, state, event journal, config scripts, runtime wiring, and CLI behavior.
- Integration tests cover Codex config/provider compatibility, OpenAI `/v1` aliases, workspace hint routing, allowlist rejection, streaming, stored snapshots, journal replay after restart, cancellation, and real Codex CLI E2E.
- Security/privacy tests already assert no token/path leakage in capabilities, metrics, logs, debug events, CLI setup output, redaction, and stored responses.
- Recent refine-arch work added active-turn capacity, approval resolution, ACP admission, worker metrics/reaper, capabilities, and SSE resume design coverage.

Gaps remain:

- repeated test setup lives in many individual test files;
- file-backed SQLite restart/migration fixtures are limited;
- raw SSE parser and wire-format golden tests are not yet first-class;
- no centralized `expectNoSensitiveData` corpus;
- real Codex CLI E2E is mixed into the general integration command;
- CI lanes are not yet decomposed by determinism and external dependency risk.

## Recommendations for architecture

Volare should design tests around four principles:

1. **Layered tests**: unit/component/HTTP/durability/backend/E2E/contract/security layers have different goals and speed.
2. **Shared harnesses**: repeated setup should move into `tests/support/`.
3. **Contract matrices**: HTTP/SSE, approval, ACP, durability, and privacy should each have explicit case matrices.
4. **Fast deterministic CI first**: external CLI and live probe checks should be isolated from fast PR gates.

## Confidence assessment

High confidence:

- The layered architecture and harness recommendations are supported by multiple independent open-source ecosystems.
- Volare's current architecture and tests align well with the recommended direction.
- SSE, durable-state, and security/privacy gaps are high-value next steps.

Medium confidence:

- Exact directory names and helper APIs should be adapted during implementation after reviewing duplication in current tests.
- CI split should account for the repository's real GitHub Actions constraints and available runners.

Lower confidence:

- Some source citations were gathered from repository file searches without full commit-SHA permalink verification.
- Some comparable projects evolve quickly; exact line ranges may drift.

## Footnotes

[^opencode-harness]: `anomalyco/opencode:packages/opencode/test/lib/effect.ts:36-176`, `anomalyco/opencode:packages/opencode/test/fake/provider.ts:5-85`.
[^opencode-llm-server]: `anomalyco/opencode:packages/opencode/test/lib/llm-server.ts:35-58,132-134,332-430,452-585,604-626,664-695,719-770`.
[^gemini-fake-generator]: `google-gemini/gemini-cli:packages/core/src/core/fakeContentGenerator.test.ts:17-128`.
[^gemini-cancel]: `google-gemini/gemini-cli:packages/core/src/core/turn.test.ts:93-126,199-237,682-707`; `google-gemini/gemini-cli:packages/core/src/agents/local-executor.test.ts:2086-2235,2640-2659`.
[^goose-mcp]: `aaif-goose/goose:crates/goose-test-support/src/mcp.rs:32-150`; `aaif-goose/goose:crates/goose/tests/session_id_propagation_test.rs:20-128,150-193`.
[^aider-temp-git]: `Aider-AI/aider:tests/basic/test_coder.py:25-80,233-264,667-735,1149-1167`.
[^langgraph-interrupt]: `langchain-ai/langgraph:libs/langgraph/tests/test_interruption.py:1-86`.
[^langgraph-persistence]: `langchain-ai/langgraph:libs/langgraph/tests/test_subgraph_persistence.py:1-9,230-352`.
[^vite-harness]: `vitejs/vite:playground/vitestSetup.ts:87-153,196-304`; `vitejs/vite:playground/test-utils.ts:132-360`.
[^astro-fixtures]: `withastro/astro:packages/astro/test/test-utils.ts:45-83,96-137,250-281`.
[^astro-cli]: `withastro/astro:packages/astro/test/test-utils.ts:324-359`; `withastro/astro:packages/astro/test/cli.test.ts:10-63`.
[^react-router-fixtures]: `remix-run/react-router:integration/helpers/create-fixture.ts:21-72,375-425`; `remix-run/react-router:integration/helpers/vite.ts:21-138,407-479`.
[^turborepo-snapshots]: `vercel/turborepo:crates/turborepo/tests/common/mod.rs:17-52`; `vercel/turborepo:crates/turborepo/tests/common/setup.rs:32-126,240-258`.
[^turborepo-config-tests]: `vercel/turborepo:crates/turborepo/tests/edit_turbo_json.rs:10-122`.
[^pnpm-exec]: `pnpm/pnpm:__utils__/prepare/src/index.ts:15-74`; `pnpm/pnpm:pnpm/test/utils/execPnpm.ts:19-229`.
[^biome-snapshots]: `biomejs/biome:crates/biome_cli/tests/main.rs:112-184,270-340`; `biomejs/biome:crates/biome_cli/tests/snap_test.rs:33-247,345-382`.
[^openai-sse]: `openai/openai-node:tests/streaming.test.ts:5-151`; `openai/openai-node:src/core/streaming.ts:37-91,176-270`.
[^eventsource-parser]: `rexxars/eventsource-parser:test/parse.test.ts:27-407`.
[^vllm-streaming]: `vllm-project/vllm:tests/entrypoints/openai/utils.py:14-118`; `vllm-project/vllm:tests/entrypoints/openai/chat_completion/test_chat.py:320-388`.
[^sse-starlette]: `sysid/sse-starlette:tests/test_sse.py:26-252`; `sysid/sse-starlette:tests/test_streaming_parity.py:14-67`.
[^langgraph-streams]: `langchain-ai/langgraph:libs/langgraph/tests/test_stream_events_v3_e2e.py:221-245`; `langchain-ai/langgraph:libs/langgraph/tests/test_pregel_stream_events_v3.py:407-423,546-554`.
[^langgraph-durable]: `langchain-ai/langgraph:libs/checkpoint-sqlite/tests/test_sqlite.py:74-126,183-305`.
[^langgraph-delta]: `langchain-ai/langgraph:libs/checkpoint-sqlite/tests/test_delta_channel_migration.py:1-15,90-173`.
[^litestream-wal]: `benbjohnson/litestream:wal_reader_test.go:14-303`.
[^litestream-restore]: `benbjohnson/litestream:restore_fuzz_test.go:17-120`; `benbjohnson/litestream:store_test.go:146-260`; `benbjohnson/litestream:tests/integration/quick_test.go:11-100`.
[^prisma-migrations]: `prisma/prisma:packages/migrate/src/__tests__/listMigrations.test.ts:13-126`; `prisma/prisma-engines:schema-engine/sql-migration-tests/tests/existing_data/mod.rs:784-866`; `drizzle-team/drizzle-orm:drizzle-kit/tests/cli-migrate.test.ts:16-98`.
[^temporal-replay]: `temporalio/sdk-typescript:packages/test/src/test-replay.ts:38-166`; `temporalio/sdk-typescript:packages/test/src/test-random-stream-reset.ts:53-109`.
[^litellm-redaction]: `BerriAI/litellm:tests/test_litellm/test_secret_redaction.py:51-303`; `BerriAI/litellm:tests/test_litellm/test_redact_string_in_error_paths.py:16-160`.
[^gemini-env]: `google-gemini/gemini-cli:packages/core/src/services/environmentSanitization.ts:7-131`; `google-gemini/gemini-cli:packages/core/src/services/environmentSanitization.test.ts:18-342`.
[^gemini-redos]: `google-gemini/gemini-cli:packages/core/src/utils/agent-sanitization-utils.test.ts:13-87`.
[^vite-host]: `vitejs/vite:packages/vite/src/node/server/middlewares/hostCheck.ts:5-54`; `vitejs/vite:packages/vite/src/node/server/middlewares/__tests__/hostCheck.spec.ts:1-25`.
[^vite-fs]: `vitejs/vite:packages/vite/src/node/server/middlewares/static.ts:211-274`; `vitejs/vite:packages/vite/src/node/server/middlewares/__tests__/static.spec.ts:1-27`.
[^owasp-cors]: `OWASP/wstg:document/4-Web_Application_Security_Testing/11-Client-side_Testing/07-Testing_Cross_Origin_Resource_Sharing.md:16-154`; `OWASP/wstg:document/4-Web_Application_Security_Testing/08-Testing_for_Error_Handling/01-Testing_For_Improper_Error_Handling.md:35-51`.
[^react-router-ci]: `remix-run/react-router:.github/workflows/integration-pr-ubuntu.yml:1-31`, `remix-run/react-router:.github/workflows/integration-pr-windows-macos.yml:1-41`, `remix-run/react-router:.github/workflows/integration-full.yml:1-49`.
[^astro-ci]: `withastro/astro:.github/workflows/ci.yml:147-178,275-390`.
[^pnpm-ci]: `pnpm/pnpm:.github/workflows/ci.yml:1-78`; `pnpm/pnpm:.github/workflows/test.yml:52-110`.
[^vite-ci]: `vitejs/vite:.github/workflows/ci.yml:1-13,29-156`.
[^gemini-ci]: `google-gemini/gemini-cli:.github/workflows/integration-tests.yml:92-182,291-386`; `google-gemini/gemini-cli:.github/workflows/ci.yml:68-107,137-180,367-443`.
[^opencode-ci]: `anomalyco/opencode:.github/workflows/test.yml:1-70,93-132`.
