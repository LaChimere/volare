# Volare architecture refinement implementation plan

## Summary

Implement the reviewed target architecture from `plans/refine-arch/arch.md` and `plans/refine-arch/design.md` as a sequence of small, independently mergeable PRs. The plan keeps Volare's current user-visible behavior stable while tightening the runtime control plane around capacity, approval, worker admission, observability, and app-layer boundaries.

## Status

Implementation complete on `lachimere/refine-arch`. PR 0 through PR 9 landed, additional review/refine cleanup landed in `bda4743`, and the late queued-cancel stream race found by final code review was fixed in `8dcec47`.

Final validation included `bun run ci`, `bun run test:package-smoke`, `bun run test:e2e:codex`, and commit-hook `test:unit` plus `check`. Older path examples in the PR plan below are preserved as planning history from before the testing architecture migration.

## Constraints

- Preserve the stateful local agent-runtime bridge direction; do not turn Volare into a generic stateless model proxy.
- Keep existing OpenAI Responses/Codex compatibility unless a specific PR documents an additive API.
- Keep core protocol-neutral: no OpenAI wire fields, Codex profile fields, ACP method names, or Copilot model-provider details in core runtime types.
- Keep security defaults: loopback binding, bearer auth, hostile Origin handling, disabled CORS, redaction, and workspace canonicalization.
- Do not add production model routing, a full tool-call broker, AG-UI/MCP/A2A surfaces, SSE resume implementation, or full ACP SDK runtime replacement in this plan.
- Use Bun tooling and existing validation commands: `bun run check`, targeted `bun test ...`, `bun run test`, and `bun run package` where startup/package behavior changes.
- Each PR must be independently mergeable and must not leave trunk in a broken intermediate state.

## Why this split

- The target architecture spans server routes, runtime core, approval flow, backend worker admission, state/journal behavior, and docs. A single PR would be too large to review safely.
- The split first captures measurements, then closes correctness/control-plane gaps, then improves boundaries and observability.
- The sequence avoids broad abstraction before concrete need: capability registry before capability endpoint, approval route before event-driven wait, worker admission before worker metrics, and design-only SSE resume before implementation.

## PR 0: Record runtime-control baseline

Goal: Capture a reproducible baseline for the runtime-control metrics that later PRs intend to improve or protect.

Likely paths:
- `plans/refine-arch/todo.md`
- `plans/refine-arch/plan.md`
- optionally `plans/refine-arch/research.md` evidence section if new measurements materially change assumptions
- no production code unless a tiny existing script addition is required for measurement

Allowed:
- Add baseline evidence tables and commands.
- Use existing logs/tests/probes to capture current behavior.
- Record gaps when a metric cannot yet be measured.

Prohibited:
- Changing runtime behavior.
- Adding a metrics framework or long-lived scripts.

Acceptance criteria:
- Baseline includes sample counts or explicit unavailability notes for:
  - backend turn latency by runtime mode
  - first assistant delta latency
  - cancellation outcomes
  - worker pressure/cap behavior
  - approval wait behavior
  - journal append cost on high-delta or synthetic event loads
- Cancellation outcomes, worker pressure/cap behavior, approval wait behavior, and journal append cost are mandatory synthetic baselines unless the plan documents a concrete blocker.
- Live Copilot latency metrics are best-effort and may use smaller samples with explicit confidence caveats.
- Synthetic metrics follow `design.md` sample guidance; each exception must document a concrete blocker.
- Live Copilot metrics include Copilot CLI version, runtime mode, sample count, and confidence caveats.

Validation:
- `bun run check`
- targeted command output captured in the plan/todo evidence

Depends on: approved `research.md`, `arch.md`, and `design.md`.

Mergeability notes:
- Documentation/evidence only; safe to merge before code changes.

## PR 1: Enforce active-turn capacity

Goal: Make `maxActiveSessions` enforce active-turn capacity with a typed retryable capacity error.

Likely paths:
- `src/core/durable-session-manager.ts`
- `src/core/types.ts`
- `src/core/errors.ts`
- `src/server/app.ts`
- `src/northbound/openai-responses/adapter.ts`
- `tests/unit_tests/core/durable-session-manager.test.ts`
- `tests/unit_tests/server/app.test.ts`
- `tests/integration_tests/codex-cli-provider.test.ts` if HTTP behavior needs integration coverage
- `docs/configuration.md` / `docs/operations.md` if behavior is user-visible

Allowed:
- Add a typed core error such as `capacity_exhausted`.
- Reject new turns before creating durable turn/session state when over active-turn capacity.
- Map active-turn capacity to HTTP `429 Too Many Requests` with `Retry-After`, optional millisecond retry hint, and OpenAI-compatible `rate_limit_error` body with `code: "capacity_exhausted"` in the active adapter.
- Add tests for concurrent over-cap requests.

Prohibited:
- Queueing HTTP turns in memory.
- Changing ACP worker cap/admission behavior in this PR.
- Adding model routing or tool brokering.

Acceptance criteria:
- Concurrent over-cap requests fail with a retryable typed capacity error.
- Adapters map the error without leaking internal objects.
- No turn/session/backend-session state leaks for rejected over-cap requests.
- Tests prove cancel intent alone does not release an active-turn slot.
- Tests prove terminal turn events release the active-turn slot exactly once.
- Tests prove backend cleanup after a terminal result does not keep the active-turn slot occupied.
- Existing cancellation and stream behavior remains unchanged.

Validation:
- `bun test tests/unit_tests/core/durable-session-manager.test.ts tests/unit_tests/server/app.test.ts`
- `bun run check`
- `bun run test`

Depends on: PR 0.

Mergeability notes:
- Changes user-visible over-cap behavior; include docs and integration coverage if status/body changes.

## PR 2: Close approval resolution loop

Goal: Add a Volare-specific control-plane approval resolution path and a waiter seam while preserving current polling behavior.

Likely paths:
- `src/server/app.ts`
- `src/approvals/provider.ts`
- `src/core/durable-session-manager.ts`
- `src/core/types.ts`
- `src/state/sqlite-store.ts` if ownership queries need support
- `tests/unit_tests/approvals/provider.test.ts`
- `tests/unit_tests/server/app.test.ts`
- `tests/unit_tests/core/durable-session-manager.test.ts`
- `docs/operations.md`

Allowed:
- Add a Volare-specific approval resolution endpoint/path.
- Introduce `IApprovalWaiter` / `IApprovalNotifier` seam with current polling implementation.
- Verify `turnId`, `approvalId`, and session/thread ownership before resolving.
- Make duplicate resolution idempotent after terminal approval status.

Prohibited:
- Routing approval resolution through OpenAI-specific semantics.
- Implementing full ACP permission callback mediation.
- Replacing polling with event-driven wait in this PR.

Acceptance criteria:
- A pending approval can be resolved through the API path.
- Wrong turn/session ownership is rejected.
- Duplicate resolve attempts return/observe the existing terminal decision without state mutation.
- Existing timeout behavior still works.
- Shutdown drives pending approvals to a durable terminal state, such as `aborted`, and resolves in-process waiters accordingly.
- Durable terminal approval state is recorded before in-process waiters are resolved.
- Error bodies for the Volare-specific control-plane endpoint are non-secret and not OpenAI-specific unless explicitly routed through an adapter.

Validation:
- `bun test tests/unit_tests/approvals/provider.test.ts tests/unit_tests/server/app.test.ts tests/unit_tests/core/durable-session-manager.test.ts`
- `bun run check`
- `bun run test`

Depends on: PR 1.

Mergeability notes:
- Additive endpoint; safe to merge with docs explaining API is Volare-specific control plane.

## PR 3: Add runtime capability registry

Goal: Introduce an internal core/control-boundary capability registry without exposing a public endpoint yet.

Likely paths:
- `src/core/types.ts`
- `src/runtime/server.ts`
- `src/backends/copilot-cli/backend.ts`
- `src/backends/copilot-cli/acp-runner.ts`
- `src/northbound/openai-responses/adapter.ts` only if adapter capability collection needs normalization
- `tests/unit_tests/runtime/server.test.ts`
- `tests/unit_tests/backends/*`

Allowed:
- Add internal registry types and merge/invalidation semantics.
- Aggregate runtime, backend, and probe-derived capabilities.
- Keep adapter-specific projection out of core.

Prohibited:
- Adding `GET /capabilities`.
- Freezing a public capability schema.
- Exposing raw ACP capabilities, local paths, tokens, or probe payloads.

Acceptance criteria:
- Unit tests cover merge behavior, invalidation/update behavior, and no adapter-specific wire fields in core.
- Invalidation triggers are covered at minimum for probe completion/re-run, backend session disposal, runtime mode change, and shutdown.
- Registry can represent `unknown`, unsupported, and supported ACP observations without overclaiming.
- No public API surface is added.

Validation:
- `bun test tests/unit_tests/runtime/server.test.ts tests/unit_tests/backends/acp-copilot-prompt-runner.test.ts`
- `bun run check`
- `bun run test`

Depends on: PR 2.

Mergeability notes:
- Internal seam only; intended to reduce future route-handler coupling.

## PR 4: Add ACP worker admission queue

Goal: Replace immediate ACP worker cap exhaustion with bounded FIFO admission that supports timeout, AbortSignal cancellation, and shutdown drain.

Likely paths:
- `src/backends/copilot-cli/admission-queue.ts` (new)
- `src/backends/copilot-cli/acp-runner.ts`
- `src/server/config.ts`
- `src/runtime/server.ts`
- `tests/unit_tests/backends/acp-copilot-prompt-runner.test.ts`
- `tests/unit_tests/server/app.test.ts`
- `docs/configuration.md`
- `docs/operations.md`

Allowed:
- Add ACP-only admission queue timeout config.
- Queue backend work after the active-turn gate.
- Remove queued work on AbortSignal.
- Release admission slots on success, failure, cancel, startup failure, timeout, and shutdown.
- Preserve hard-fail behavior when queue timeout is configured as `0`, if chosen.

Prohibited:
- Queueing active HTTP turns before active-turn capacity is checked.
- Changing core turn status semantics by overloading `queued`.
- Adding per-workspace fairness in this PR.

Acceptance criteria:
- Concurrent worker-cap tests prove FIFO drain.
- Queued abort removes the entry and does not leak slots.
- Abort during worker creation terminates startup and releases the slot.
- Queue timeout returns a distinct typed error such as `backend_worker_admission_timeout`, mapped by adapters to retryable capacity semantics (`429` for OpenAI Responses).
- AbortSignal/client-disconnect admission cancellation is not reported as capacity pressure; it terminates as cancellation/incomplete when a response is still observable.
- Shutdown drain rejects queued admissions with a distinct service-lifecycle error mapped to `503` plus retry hints when a wire response is possible.
- Admission timeout, admission abort, and shutdown drain release the active-turn slot through a terminal turn event/result when a turn record exists.

Validation:
- `bun test tests/unit_tests/backends/acp-copilot-prompt-runner.test.ts tests/unit_tests/server/app.test.ts`
- `bun run check`
- `bun run test`

Depends on: PR 3.

Mergeability notes:
- Behavior change under ACP pressure; keep default conservative and document rollback to hard-fail if supported.

## PR 5: Add ACP worker observability and idle reaper

Goal: Make ACP worker pressure visible and clean idle workers without waiting for a new request.

Likely paths:
- `src/backends/copilot-cli/acp-runner.ts`
- `src/server/app.ts`
- `src/runtime/server.ts`
- `src/server/config.ts`
- `src/events/*` and `src/state/*` if journal safe-close or drain behavior needs explicit support
- `tests/unit_tests/backends/acp-copilot-prompt-runner.test.ts`
- `tests/unit_tests/server/app.test.ts`
- `docs/operations.md`

Allowed:
- Add worker/admission snapshot method or metrics provider seam.
- Expose active, creating, idle, queue depth, timeout, and cancelled admission counts.
- Add background idle reaper with safe shutdown/`unref` behavior.
- Add structured log events for admission and idle reaping.

Prohibited:
- Changing admission semantics from PR 4.
- Adding Prometheus/OpenTelemetry framework.
- Persisting worker process state.

Acceptance criteria:
- `/metrics` includes non-secret worker/admission pressure fields.
- Idle workers are reaped without a new request and without interfering with active workers or admission accounting.
- Shutdown stops accepting new turns/admissions before draining queued or active work.
- New turns/admissions received after shutdown stop-accepting begins use the same service-lifecycle unavailable mapping as shutdown drain rejection.
- Shutdown drains queued admissions and active workers according to documented timeouts.
- Shutdown flushes or safely closes the event journal after terminal cleanup has been recorded.
- Metrics/logs do not include prompts, tokens, raw ACP frames, or local secret paths.

Validation:
- `bun test tests/unit_tests/backends/acp-copilot-prompt-runner.test.ts tests/unit_tests/server/app.test.ts`
- `bun run check`
- `bun run test`

Depends on: PR 4.

Mergeability notes:
- Additive observability and cleanup; safe to merge after admission semantics are stable.

## PR 6: Split HTTP app hot-path responsibilities

Goal: Extract `app.ts` responsibilities without behavior changes.

Likely paths:
- `src/server/app.ts`
- new files under `src/server/` for stream lifecycle, route helpers, metrics, journal wrapper, or transport errors
- `src/northbound/openai-responses/` for OpenAI-specific error encoder extraction
- `tests/unit_tests/server/app.test.ts`
- `tests/integration_tests/codex-cli-provider.test.ts`

Allowed:
- Extract stream lifecycle observer.
- Extract journal wrapper.
- Extract metrics collector.
- Move OpenAI Responses error encoding into the adapter package.
- Extract route handlers while keeping the same HTTP behavior.

Prohibited:
- Changing endpoint behavior or response schemas.
- Mixing in approval/capacity/admission feature work.
- Broad rewrite of `app.ts` in one commit.

Acceptance criteria:
- Route/status/SSE behavior remains unchanged.
- OpenAI error body encoding lives in adapter/northbound code.
- Transport status/headers/request ID remain app-layer responsibilities.
- Tests prove no behavior change for existing routes.

Validation:
- `bun test tests/unit_tests/server/app.test.ts tests/integration_tests/codex-cli-provider.test.ts`
- `bun run check`
- `bun run test`

Depends on: PR 4 for stable admission/control-plane semantics. PR 5 worker-observability can run in parallel, but any metrics-collector extraction in PR 6 should coordinate with PR 5.

Mergeability notes:
- Prefer multiple micro-PRs inside this phase if the diff grows: stream lifecycle, journal wrapper, metrics collector, error encoder, route cleanup.

## PR 7: Replace approval polling with event-driven waiter

Goal: Reduce approval wait latency and SQLite polling while retaining SQLite fallback for restart/cross-process decisions.

Likely paths:
- `src/approvals/provider.ts`
- `src/core/durable-session-manager.ts`
- `src/core/types.ts`
- `tests/unit_tests/approvals/provider.test.ts`
- `tests/unit_tests/core/durable-session-manager.test.ts`

Allowed:
- Add in-process notifier/condition for same-process approval decisions.
- Keep SQLite polling fallback for waiters not registered in-process or after restart.
- Preserve timeout and abort semantics.

Prohibited:
- Removing SQLite as approval source of truth.
- Requiring a long-lived external message bus.
- Changing approval decision API shape from PR 2 unless a bug is found.

Acceptance criteria:
- Same-process approval resolution wakes without waiting for the polling interval.
- Restart/cross-process fallback still observes SQLite decision.
- Approval timeout and abort paths still produce terminal states.
- Duplicate resolution remains idempotent.

Validation:
- `bun test tests/unit_tests/approvals/provider.test.ts tests/unit_tests/core/durable-session-manager.test.ts`
- `bun run check`
- `bun run test`

Depends on: PR 2 for the waiter seam and PR 6 for app/control-plane extraction.

Mergeability notes:
- Isolated improvement if PR 2 introduced the waiter seam as planned.

## PR 8: Expose capabilities endpoint

Goal: Add a versioned, non-secret public capabilities projection after the internal registry is stable.

Likely paths:
- `src/server/app.ts`
- `src/core/types.ts`
- `src/northbound/openai-responses/adapter.ts`
- `src/runtime/server.ts`
- `tests/unit_tests/server/app.test.ts`
- `docs/operations.md`

Allowed:
- Add `GET /capabilities` or equivalent Volare-specific endpoint.
- Return schema version, server identity, protocol support, runtime capabilities, backend runtime observations, and security posture.
- Use `Cache-Control: no-store`.

Prohibited:
- Dumping internal registry objects directly.
- Exposing raw ACP capabilities, local paths, tokens, raw probe output, or auth metadata.
- Advertising unstable capabilities as stable booleans without source/evidence fields.

Acceptance criteria:
- Endpoint returns a versioned, non-secret adapter projection derived from registry plus adapter capabilities.
- ACP native cancel support is represented as `unknown`, `unsupported`, `native-terminal-only`, or `native-reusable`, not as an overclaiming boolean.
- Response includes `Cache-Control: no-store`.
- Tests cover no secret/path leakage.

Validation:
- `bun test tests/unit_tests/server/app.test.ts`
- `bun run check`
- `bun run test`

Depends on: PR 3 for registry semantics and PR 6 for route/app boundary clarity.

Mergeability notes:
- Additive endpoint; keep schema minimal.

## PR 9: Design SSE resume and AgentEvent schema versioning

Goal: Produce a design-only PR for event IDs, `Last-Event-ID` replay semantics, terminal idempotency, and journal event upcasting.

Likely paths:
- `plans/refine-arch/design.md` or a new follow-up design file
- possibly `docs/architecture.md` if canonical behavior changes after approval
- no production implementation unless explicitly approved later

Allowed:
- Define `JournalEnvelopeV1` / event schema versioning strategy.
- Define SSE event ID format; the approved design uses `turn:<turn_id>:seq:<sequence>:part:<frame_part>`.
- Define replay cursor behavior and terminal-event idempotency.
- Define future test plan for journals written under at least one prior schema version.

Prohibited:
- Implementing SSE resume in the design PR.
- Changing journal schema before migration design is approved.

Acceptance criteria:
- Design explains event ID assignment, replay cursor semantics, terminal-event idempotency, and schema migration/upcaster strategy.
- Design includes validation plan for duplicate/skipped terminal events and prior-version journal replay.
- Design explicitly lists required migrations, if any.

Validation:
- Documentation review with Claude xhigh + GPT high-reasoning review, per user preference.

Depends on: PR 8.

Mergeability notes:
- Design-only; implementation should be a separate approved plan.

## Follow-up designs after this plan

These target-architecture items are intentionally not implemented in this PR sequence, but they must not be forgotten:

- ACP permission callback translator from backend runtime into the control-plane permission/approval pipeline. This should follow approval closure and event-driven approval wait, because it depends on safe async approval mediation.
- Thread/Turn/BackendSession manager extraction from `DurableSessionManager`. This should be planned as a no-behavior-change refactor after the first control-plane fixes reduce immediate correctness risk.
- Enterprise/shared-deployment content policy provider. This should be designed when shared deployment or broader workspace-content ingestion becomes a committed requirement.

## Parallelization readiness

Must stay serial:
- PR 0 -> PR 1 -> PR 2 -> PR 3 -> PR 4
- PR 7 depends on the approval waiter seam from PR 2 and enough app/control cleanup from PR 6.
- PR 8 depends on internal capability registry from PR 3 and enough route/app boundary clarity from PR 6.
- PR 9 depends on state/journal design clarity and should remain design-only until approved.

Can fan out after base/control-plane contracts stabilize:
- PR 5 worker observability and PR 6 app-boundary cleanup can proceed in parallel after PR 4 if path ownership is clear. Coordinate PR 5 metrics output with any PR 6 metrics-collector extraction.
- Some PR 6 extraction slices can be split and reviewed independently if path ownership is clear.
- Docs updates tied to each phase should ship with that phase.

Use `plan-parallel-work` before assigning multiple agents because `src/server/app.ts`, `src/core/durable-session-manager.ts`, and ACP runner files are conflict hotspots.

## Risks

- **Contract churn:** capacity, approval, and capability seams may affect many tests if introduced too broadly.
- **Migration hazards:** event schema versioning and SSE resume will require careful journal compatibility design.
- **Conflict hotspots:** `src/server/app.ts`, `src/core/durable-session-manager.ts`, `src/backends/copilot-cli/acp-runner.ts`, `src/server/config.ts`.
- **Behavior drift:** app extraction must preserve current HTTP/SSE behavior exactly.
- **Security regression:** approval/content policy work must fail closed and preserve redaction.
- **Over-design:** do not add model routing, full tool broker, AG-UI/MCP/A2A, or full SDK replacement before a concrete product need.

## Rollback

- PR 1 active-turn cap can be disabled or loosened by config if the typed error path is correct.
- PR 2 approval endpoint is additive; disabling the route reverts behavior.
- PR 3 registry is internal; callers can ignore it.
- PR 4 admission queue should support timeout `0` or equivalent hard-fail behavior to restore current semantics.
- PR 5 observability/reaper can be disabled by config if needed.
- PR 6 extractions are refactors; rollback is file movement/revert.
- PR 7 event-driven waiter keeps polling fallback.
- PR 8 capabilities endpoint is additive.
- PR 9 is design-only.
