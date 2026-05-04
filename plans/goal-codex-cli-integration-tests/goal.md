# Goal State

objective: "integration tests 暂时不用考虑 desktop 的，确保 codex cli 能够正常用。你需要好好设计下我们的 it 要怎么做，我需要你为我们项目的所有 scenarios 都加上 it cases。代码中不要出现中文。"
status: complete
slug: "goal-codex-cli-integration-tests"
turns_used: 1
turn_budget: null
docs_update_approved: false
created_at: "2026-05-04T18:23:58+08:00"
updated_at: "2026-05-04T18:35:00+08:00"

## Acceptance criteria

### User-visible behavior

- Codex CLI-oriented integration tests cover the supported local provider flow without relying on Desktop-specific assumptions.
- The integration suite includes scenarios for the project's HTTP boundary, Responses streaming, stored response lookup, continuation, cancellation, workspace metadata, auth/security, and CLI configuration behavior.
- Test code does not contain Chinese text.

### Implementation scope

- Replace the temporary Desktop-oriented integration test with a Codex CLI-oriented integration suite under `tests/integration_tests/`.
- Add reusable integration-test helpers only when they keep scenarios clear and avoid over-engineering.
- Preserve current runtime behavior except for fixes required by integration failures.
- Keep usage/token-accounting improvements out of scope unless required to make existing behavior testable.

### Validation

- Run targeted integration tests.
- Run `bun run test:integration`.
- Run `bun run check` and `bun run test`.
- Run at least one review/refinement pass focused on missing scenarios and flaky tests.

### Docs/status

- Keep this goal state updated with the scenario design, progress, blockers, and completion audit.
- Update docs only if integration work reveals a behavior/documentation mismatch.

### Deferred/out of scope

- Codex Desktop-specific behavior is out of scope for this integration-test goal.
- Real Copilot CLI process execution is out of scope for integration tests; tests should use deterministic backends unless explicitly smoke-testing daemon startup.
- Usage/token-accounting improvements remain out of scope.

## Progress log

- Turn 0: Goal registered. Next slice is to design the Codex CLI integration scenario matrix and implement the test harness.
- Turn 1: Integration-test scenario matrix designed for Codex CLI provider usage: Codex config generation, authenticated service routes, model catalog, workspace metadata/projectless routing, streaming Responses requests with Codex CLI controls, stored response lookup, durable continuation and replay, cancellation/disconnect behavior, debug events, and error boundaries. Desktop-specific assumptions and Chinese test strings are excluded.
- Turn 1: Implemented `tests/integration_tests/codex-cli-provider.test.ts` with 9 Codex CLI-oriented scenarios. Removed temporary root-level exploratory test files, verified no non-ASCII or Chinese characters in integration test code, and committed the suite atomically as `f1af29e`.

## Deferred items

- Codex Desktop-specific integration coverage; reason=out_of_scope.
- Real Copilot CLI process integration in automated tests; reason=out_of_scope.
- Usage/token-accounting improvements; reason=out_of_scope.

## Blockers

- None.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: Codex CLI-oriented integration tests cover the supported local provider flow without relying on Desktop-specific assumptions. | `tests/integration_tests/codex-cli-provider.test.ts` is named and scoped for Codex CLI provider behavior; Desktop-specific naming and assumptions were removed. | met |
| User-visible behavior: The integration suite includes scenarios for the project's HTTP boundary, Responses streaming, stored response lookup, continuation, cancellation, workspace metadata, auth/security, and CLI configuration behavior. | The suite covers config generation, authenticated health/metrics/models, projectless and explicit workspace hints, streaming Responses, stored snapshots, latest-turn attachments, durable continuation, replay after restart, debug events, cancellation, disconnects, and explicit error boundaries. | met |
| User-visible behavior: Test code does not contain Chinese text. | A Python scan over `tests/integration_tests` found no non-ASCII characters and no Chinese characters in integration test code. | met |
| Implementation scope: Replace the temporary Desktop-oriented integration test with a Codex CLI-oriented integration suite under `tests/integration_tests/`. | `codex-desktop-responses.test.ts` was replaced by `codex-cli-provider.test.ts`. | met |
| Implementation scope: Add reusable integration-test helpers only when they keep scenarios clear and avoid over-engineering. | Helpers are local to the test file and cover HTTP server startup, JSON POSTs, SSE parsing, response id extraction, durable app wiring, and polling for terminal stored state. | met |
| Implementation scope: Preserve current runtime behavior except for fixes required by integration failures. | This goal added tests only; runtime code was not changed. | met |
| Implementation scope: Keep usage/token-accounting improvements out of scope unless required to make existing behavior testable. | No usage/token-accounting changes were made. | met |
| Validation: Run targeted integration tests. | `bun test tests/integration_tests/codex-cli-provider.test.ts` passed with 9 tests. | met |
| Validation: Run `bun run test:integration`. | `bun run test:integration` passed with the Codex CLI integration suite. | met |
| Validation: Run `bun run check` and `bun run test`. | `bun run check` and `bun run test` passed; pre-commit for `f1af29e` also ran check/test successfully. | met |
| Validation: Run at least one review/refinement pass focused on missing scenarios and flaky tests. | Independent review found no blocking issue in the test implementation; its only concern was Chinese in the goal objective, which is preserved verbatim by the goal workflow and is outside test code. | met |
| Docs/status: Keep this goal state updated with the scenario design, progress, blockers, and completion audit. | This file records the design, progress, blockers, and completion audit. | met |
| Docs/status: Update docs only if integration work reveals a behavior/documentation mismatch. | No behavior/documentation mismatch was found; docs were not changed for this goal. | met |
| Deferred/out of scope: Codex Desktop-specific behavior is out of scope for this integration-test goal. | Desktop-specific coverage remains deferred. | deferred-out-of-scope |
| Deferred/out of scope: Real Copilot CLI process execution is out of scope for integration tests; tests should use deterministic backends unless explicitly smoke-testing daemon startup. | The suite uses deterministic in-memory/durable app dependencies and mock/blocking backends. | deferred-out-of-scope |
| Deferred/out of scope: Usage/token-accounting improvements remain out of scope. | Usage/token accounting was not changed. | deferred-out-of-scope |
