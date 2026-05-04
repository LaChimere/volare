# Goal State

objective: "你应该把上面我们提到的真正的 cli integration test 作为我们 it 的目标，确保和 codex cli 等 cli 能够预期工作。你可以深度调研和好好设计一下，看看从长期最佳实践做要怎么来测试"
status: complete
slug: "goal-real-cli-integration-tests"
turns_used: 1
turn_budget: null
docs_update_approved: false
created_at: "2026-05-04T19:59:37+08:00"
updated_at: "2026-05-04T20:15:00+08:00"

## Acceptance criteria

### User-visible behavior

- The integration-test target runs real CLI clients, starting with Codex CLI, through Volare rather than only exercising Volare's HTTP adapter directly.
- The Codex CLI integration verifies expected behavior, not just that a response is returned.
- The temporary-project status scenario proves the selected workspace is the intended project and unrelated project/context artifacts are not leaked into the answer.
- The design remains extensible to future CLI clients such as Claude Code without over-designing the core runtime.

### Implementation scope

- Add a mandatory Codex CLI end-to-end integration test under `tests/integration_tests/`.
- Use a deterministic in-process Volare backend for the E2E so the test validates client/protocol/workspace behavior without depending on live model quality.
- Keep Codex CLI configuration isolated with temporary `CODEX_HOME`, temporary project roots, and local Volare API keys.
- Make failures actionable when required local CLI prerequisites are unavailable.

### Validation

- Run the new Codex CLI E2E directly.
- Run `bun run test:integration`.
- Run `bun run check` and `bun run test`.
- Review the scenario for false positives, context leakage blind spots, and long-term maintainability.

### Docs/status

- Keep this goal state updated with design choices, progress evidence, blockers, and completion audit.
- Update related documentation only if the final integration-test behavior changes documented workflows.

### Deferred/out of scope

- Codex Desktop UI automation remains out of scope for this goal.
- Live Copilot model quality evaluation is out of scope; this goal validates CLI/client/protocol/workspace integration with deterministic Volare backend behavior.
- Claude Code integration tests are a future extension point unless a minimal shared harness falls naturally out of the Codex CLI work.

## Progress log

- Turn 0: Goal registered. Existing integration tests were confirmed to cover Volare's HTTP Responses surface but not real `codex exec` client behavior.
- Turn 1: Added a mandatory real Codex CLI E2E that creates a temporary project, configures an isolated temporary `CODEX_HOME`, routes `codex exec` through an in-process Volare server, and asserts both the CLI's final answer and the backend request stay scoped to the temporary project. The E2E exposed Codex harness context leakage, so the OpenAI Responses adapter now filters Codex context-only fragments and harness instructions before prompting the backend while preserving ordinary client instructions. CI now installs `@openai/codex@0.128.0` before running the integration suite. Review found two blocking issues (missing CI Codex CLI prerequisite and overly broad harness filtering); both were fixed and revalidated.

## Deferred items

- Codex Desktop UI automation; reason=out_of_scope.
- Live Copilot model quality evaluation; reason=out_of_scope.
- Claude Code real CLI E2E; reason=future_phase.
- Related docs refresh for real CLI E2E and Codex harness filtering; reason=needs_user_decision after doc-update approval was not available.

## Blockers

- None.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: The integration-test target runs real CLI clients, starting with Codex CLI, through Volare rather than only exercising Volare's HTTP adapter directly. | `tests/integration_tests/codex-cli-e2e.test.ts` invokes real `codex exec` with a temporary `CODEX_HOME`, temporary project root, and Volare provider config pointing to a local in-process Volare server. | met |
| User-visible behavior: The Codex CLI integration verifies expected behavior, not just that a response is returned. | The E2E asserts `codex exec` exits successfully, Volare backend receives exactly one request, the resolved workspace root is the temporary project root, forbidden context terms are absent from the backend request, and the final CLI output mentions only the expected README/project status. | met |
| User-visible behavior: The temporary-project status scenario proves the selected workspace is the intended project and unrelated project/context artifacts are not leaked into the answer. | The E2E canonicalizes the temp project root, configures it as the only allowed workspace, and fails if backend request/final output mention `AGENTS.md`, `auth.json`, `config.toml`, `version.json`, or `skills/`. | met |
| User-visible behavior: The design remains extensible to future CLI clients such as Claude Code without over-designing the core runtime. | The test is a client harness around the existing HTTP adapter and deterministic backend; runtime changes are limited to filtering Codex-specific client/harness context in the OpenAI Responses adapter. Claude Code remains deferred as a future real CLI E2E. | met |
| Implementation scope: Add a mandatory Codex CLI end-to-end integration test under `tests/integration_tests/`. | Added `tests/integration_tests/codex-cli-e2e.test.ts`; it is not skipped and runs as part of `bun run test:integration`. | met |
| Implementation scope: Use a deterministic in-process Volare backend for the E2E so the test validates client/protocol/workspace behavior without depending on live model quality. | The E2E uses `ProjectStatusBackend`, `DurableSessionManager`, `SQLiteStateStore`, and an in-process `createApp()` server rather than live Copilot model output. | met |
| Implementation scope: Keep Codex CLI configuration isolated with temporary `CODEX_HOME`, temporary project roots, and local Volare API keys. | The E2E creates a temp root, writes `README.md`, configures a temp Codex config, and sets `CODEX_HOME`/`VOLARE_API_KEY` only in the spawned Codex process environment. | met |
| Implementation scope: Make failures actionable when required local CLI prerequisites are unavailable. | The E2E calls `codex --version` first and fails with a clear "codex CLI is required" error when it is unavailable; CI installs `@openai/codex@0.128.0`. | met |
| Validation: Run the new Codex CLI E2E directly. | `bun test tests/unit_tests/northbound/openai-responses-adapter.test.ts tests/integration_tests/codex-cli-e2e.test.ts --timeout=70000` passed. | met |
| Validation: Run `bun run test:integration`. | `bun run test:integration` passed with the mandatory Codex CLI E2E included. | met |
| Validation: Run `bun run check` and `bun run test`. | `bun run check` and `bun run test` passed after formatting fixes. | met |
| Validation: Review the scenario for false positives, context leakage blind spots, and long-term maintainability. | Independent review identified missing CI Codex install and overly broad harness filtering; CI install and stricter harness signatures plus preservation tests were added and revalidated. | met |
| Docs/status: Keep this goal state updated with design choices, progress evidence, blockers, and completion audit. | This file records design, progress, deferred items, blockers, and this completion audit. | met |
| Docs/status: Update related documentation only if the final integration-test behavior changes documented workflows. | Related docs refresh was not performed because the doc-update approval prompt did not receive explicit approval; it is recorded as a deferred item with reason=needs_user_decision. | deferred-out-of-scope |
| Deferred/out of scope: Codex Desktop UI automation remains out of scope for this goal. | No Desktop UI automation was added. | deferred-out-of-scope |
| Deferred/out of scope: Live Copilot model quality evaluation is out of scope; this goal validates CLI/client/protocol/workspace integration with deterministic Volare backend behavior. | The E2E validates Codex CLI/Volare protocol behavior with deterministic backend output and does not depend on live Copilot model quality. | deferred-out-of-scope |
| Deferred/out of scope: Claude Code integration tests are a future extension point unless a minimal shared harness falls naturally out of the Codex CLI work. | Claude Code remains listed as a future-phase deferred item. | deferred-out-of-scope |
