# Codex latency observability todo

## Status

Current gate: plan/todo created after finalized design. Runtime implementation has not started in this artifact.

Execution note: do not create commits until checks for the current slice pass and the user explicitly allows committing.

## Tasks

- [x] `server-request-phase-metrics`: Add `POST /responses` request phase timing fields to `http.request.completed` without changing other route semantics.
- [x] `responses-duration-semantics`: Document and test the `POST /responses`-only meaning of `http.request.completed.durationMs` as request received to SSE `Response` creation.
- [ ] `sse-lifecycle-observer`: Add local adapter/server stream lifecycle observer hooks for SSE frame count, first pull, first assistant frame, terminal frame, `[DONE]` observation, event-specific stream fields, `sseActiveMs` semantics, and the finalized interruption reason/phase taxonomy.
- [ ] `sse-finalizer-classification`: Replace canonical-event wrapper lifecycle logging with `StreamLifecycleContext` plus an idempotent stream finalizer that follows the precedence rules in `design.md`; cancellation handlers only record state, while final classification happens in the finalizer.
- [ ] `sse-tests-docs`: Add server/SSE lifecycle tests and update operations docs/integration tests for PR 1 event semantics, including `responses.stream.cancelled` migration, `responseOutcome: unknown`, and omitted first-assistant timing fields.
- [ ] `core-turn-summary-metrics`: Add manager-side state/turn summary timing fields where cheap and protocol-neutral; keep `sessionStartMs` and `stateStartMs` relationship clear and non-additive.
- [ ] `backend-turn-summary-metrics`: Add Copilot backend summary fields for prompt assembly, first output where observable, assistant delta cadence, coarse size buckets, and failure classes; keep SSE, canonical event, and backend delta counting layers separate, track delta cadence with O(1) state only, add no per-delta info logs, and omit unavailable timing fields instead of writing `0`.
- [ ] `journal-slow-warning`: Decide whether a capped `journal.append.slow` warning is useful; implement it only if it can stay at most once per turn, otherwise record the deferral.
- [ ] `core-backend-tests-docs`: Add tests and docs for core/backend summary metrics, safe failure-field sanitization, cancellation cadence non-comparability, and correlation between stream disconnects and backend cancellation summaries.
- [ ] `latency-playbook`: Add the slow Codex turn investigation playbook and final metric catalog to operations docs, including safe local log parsing examples, repeated `responseOutcome: unknown` guidance, and no double-counting of correlated stream/backend cancellation summaries.
- [ ] `metrics-followup-decision`: Document whether `/metrics` aggregates and analyzer tooling remain deferred or need a separately approved follow-up, using the concrete revisit criteria from `design.md`.

## Dependencies

- `responses-duration-semantics` follows `server-request-phase-metrics`.
- `sse-lifecycle-observer` follows `responses-duration-semantics`.
- `sse-finalizer-classification` follows `sse-lifecycle-observer`.
- `sse-tests-docs` follows `sse-finalizer-classification`.
- `core-backend-tests-docs` follows `core-turn-summary-metrics`, `backend-turn-summary-metrics`, and the `journal-slow-warning` decision.
- `latency-playbook` follows `sse-tests-docs` and `core-backend-tests-docs`.
- `metrics-followup-decision` follows `latency-playbook`.

## Validation commands

- `bun run check`
- `bun run test`

## Evidence

- `server-request-phase-metrics`, `responses-duration-semantics`: added `POST /responses` phase fields and request-ready `durationMs` coverage in `src/server/app.ts` and `tests/unit_tests/server/app.test.ts`. Validation: `bun test tests/unit_tests/server/app.test.ts --pass-with-no-tests`; `bun run check && bun run test`.

## Notes

- Do not log prompts, request bodies, tool payloads, shell commands, stderr contents, hashes, slices, or per-message length arrays.
- Do not log tokens, prompt prefixes/suffixes, attachment contents, raw `error.cause`, or serialized `VolareError` payloads.
- Do not change Copilot CLI invocation semantics, prompt content, permission behavior, backend session model, package version, or release state.
- Keep `model` and `reasoningEffort` as client-requested correlation metadata only.
- Use the bucket bands from `design.md`; defer `firstStdoutMs` explicitly if it requires a broad runner API change.
