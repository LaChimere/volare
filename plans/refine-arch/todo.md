# Volare architecture refinement todo

## Status

Execution in progress. PR 0 baseline, PR 1 active-turn capacity, PR 2 approval resolution, and PR 3 runtime capability registry have been completed.

## PR 0: Runtime-control baseline

- [x] Record baseline metric collection commands
- [x] Capture backend turn latency by runtime mode, or document why unavailable
- [x] Capture first assistant delta latency, or document why unavailable
- [x] Capture cancellation outcome distribution
- [x] Capture active-turn/worker pressure behavior
- [x] Capture approval wait behavior
- [x] Capture journal append cost on synthetic/high-delta workload
- [x] Add baseline evidence to this slug

Acceptance evidence:

- [x] Baseline includes sample counts or confidence caveats
- [x] Synthetic baseline satisfies `design.md` sample guidance; each exception documents a concrete blocker
- [x] Cancellation outcomes, worker pressure/cap behavior, approval wait behavior, and journal append cost have mandatory synthetic baselines or documented blockers
- [x] No production behavior changes

Evidence:

- Command: `bun /tmp/refine-arch-baseline.ts`
- Environment: Bun `1.3.14`, Darwin.
- Live Copilot latency was not run in this PR 0 slice to avoid external-service noise; prior ACP live probe evidence remains in `plans/copilot-backend-runtime/`.

| Metric | Samples | p50 | p90 | Max | Notes |
|---|---:|---:|---:|---:|---|
| Synthetic turn lifecycle | 30 | 0.05ms | 0.08ms | 1.19ms | In-memory backend through `DurableSessionManager` |
| Cancellation | 20 | 0.02ms | 0.03ms | 0.30ms | Outcomes: `cancelled=20` |
| Approval wait | 20 | 1.16ms | 1.20ms | 2.32ms | `ApprovalProvider` with `pollMs=1`; resolve scheduled after 1ms |
| Journal append | 1000 | 0.01ms | 0.01ms | 0.40ms | Total 8.02ms for 1000 canonical events |
| ACP worker cap pressure | 6 attempts | n/a | n/a | n/a | `cap=2`; fulfilled=2, `backend_worker_cap_exhausted=4` |

## PR 1: Active-turn capacity

- [x] Add typed active-turn capacity error
- [x] Enforce `maxActiveSessions` before creating durable turn/session state
- [x] Map capacity error to HTTP 429 with `Retry-After`, optional millisecond hint, OpenAI `rate_limit_error`, and `code: "capacity_exhausted"`
- [x] Add unit tests for over-cap concurrency
- [x] Add tests proving cancel intent alone does not release active-turn capacity
- [x] Add tests proving terminal events release active-turn capacity exactly once
- [x] Add tests proving backend cleanup after terminal result does not keep capacity occupied
- [x] Add server/adapter tests for status/body/headers
- [x] Update docs if user-visible behavior changes

Acceptance evidence:

- [x] Over-cap requests fail with typed retryable capacity error
- [x] No turn/session state is leaked for rejected requests
- [x] Existing cancellation and streaming tests remain green

Evidence:

- Core active-turn slots are reserved before durable state creation and tracked by reserved turn IDs; releasing an unreserved or foreign turn is a no-op.
- Concurrent over-cap starts reject exactly one request with `capacity_exhausted` and leave only one durable turn row.
- Cancel intent alone keeps the slot occupied until terminal cancel completion; terminal stream events release the slot immediately and idempotently before backend cleanup finishes.
- Response stream setup failures after `startTurn` cancel the accepted turn and log cleanup failures without masking the original setup error.
- Milestone review follow-up: stream startup failures before the first event, including scope mismatches and `queued` to `running` state-update failures, release active-turn capacity through `streamTurn`'s `finally`.
- OpenAI Responses capacity errors return HTTP 429 with `Retry-After`, `X-Volare-Retry-After-Ms`, `X-Volare-Capacity-Scope`, `type: "rate_limit_error"`, and `code: "capacity_exhausted"`.
- Documentation updated: `docs/configuration.md` now describes `VOLARE_MAX_ACTIVE_SESSIONS` as the active-turn cap and the retryable over-cap rejection behavior.
- Review: code-review and rubber-duck review completed; blocking findings were fixed, and re-review reported no material issues.
- Validation:
  - `bun test tests/unit_tests/core/durable-session-manager.test.ts tests/unit_tests/server/app.test.ts && bunx tsc --noEmit --pretty false`
  - `bun run check && bun run test`

## PR 2: Approval resolution

- [x] Add `IApprovalWaiter` / `IApprovalNotifier` seam with polling implementation
- [x] Add Volare-specific approval resolution endpoint/path
- [x] Validate approval ownership using turn/session/approval identifiers
- [x] Preserve timeout and abort behavior
- [x] Make duplicate terminal resolution idempotent
- [x] Ensure shutdown drives pending approvals to a durable terminal state and resolves in-process waiters
- [x] Record durable terminal approval state before resolving in-process waiters
- [x] Add approval provider, server, and session-manager tests
- [x] Document endpoint and operational behavior

Acceptance evidence:

- [x] Pending approval resolves through API
- [x] Wrong ownership is rejected
- [x] Duplicate resolve does not mutate terminal state
- [x] Timeout still works
- [x] Shutdown resolves or aborts pending approval waiters to a terminal state
- [x] Volare-specific approval endpoint errors are non-secret and not OpenAI-specific

Evidence:

- Added `IApprovalWaiter` / `IApprovalNotifier` seams and an ownership-aware `ApprovalProvider.resolveApproval(...)`.
- Added `POST /control/approvals/:approvalId/resolve` with Volare control-plane error bodies and manual `allow`/`deny` decision validation.
- Approval ownership is validated across approval, turn, bridge session, and thread before mutation; mismatches return `approval_scope_mismatch`.
- Duplicate terminal resolves return the stored decision and do not append a new journal event.
- Shutdown sets the provider into draining mode, waits for in-flight approval evaluations before aborting pending approvals, and returns a combined aborted-approval count.
- Startup/shutdown recovery drives pending approvals to durable `aborted` state and appends shared `permission.resolved` journal events via `permissionResolvedJournalEvent`.
- Documentation updated: `docs/operations.md` documents the Volare approval resolution endpoint and non-OpenAI control-plane error envelope.
- Review/refine: multiple code-review and rubber-duck rounds completed; findings about formatting, duplicated journal event shapes, shutdown drain races, misleading recovery reason, and abort-count observability were fixed before commit.
- Validation:
  - `bun test tests/unit_tests/approvals/provider.test.ts tests/unit_tests/server/app.test.ts tests/unit_tests/core/durable-session-manager.test.ts tests/unit_tests/server/shutdown.test.ts tests/unit_tests/state/sqlite-store.test.ts && bun run check`
  - `bun run test`

## PR 3: Runtime capability registry

- [x] Add internal runtime/backend capability registry types
- [x] Aggregate runtime features, backend capabilities, and probe-derived ACP support
- [x] Add invalidation/update semantics
- [x] Keep adapter-specific wire projection out of core
- [x] Add unit tests for merge and invalidation behavior

Acceptance evidence:

- [x] Registry is internal only
- [x] No public endpoint added
- [x] No adapter wire fields leak into core
- [x] Invalidation triggers cover probe completion/re-run, backend session disposal, runtime mode change, and shutdown

Evidence:

- Added internal `RuntimeCapabilityRegistry` with runtime features, backend capabilities, and classified ACP native-cancel observations.
- Registry remains internal to runtime/backend wiring; no `GET /capabilities` or public projection was added.
- ACP native cancel observations classify `unknown`, `unsupported`, `native-terminal-only`, and `native-reusable` without exposing raw ACP payloads or overclaiming transient failures.
- ACP runner records successful reusable native cancel probes, negative probe evidence, worker disposal, worker replacement, worker exit, and shutdown/runtime invalidations.
- Tests cover merge behavior, probe completion/re-run, backend disposal/worker exit, runtime mode change, shutdown invalidation, and runner probe observation updates.
- Review/refine: code-review and rubber-duck rounds found overclaim/disposal/worker-exit gaps; each was fixed and re-reviewed with no material issues remaining.
- Validation:
  - `bun test tests/unit_tests/runtime/server.test.ts tests/unit_tests/backends/acp-copilot-prompt-runner.test.ts && bun run check`
  - `bun run test`

## PR 4: ACP worker admission queue

- [ ] Add `WorkerAdmissionQueue` primitive
- [ ] Add ACP admission timeout config
- [ ] Wire ACP runner through admission queue
- [ ] Support queued AbortSignal cancellation
- [ ] Support abort during worker creation
- [ ] Release slots on success, failure, cancel, timeout, startup failure, and shutdown
- [ ] Add queue timeout typed error
- [ ] Add targeted ACP runner tests
- [ ] Update config and operations docs

Acceptance evidence:

- [ ] FIFO drain proven
- [ ] Queued abort removes entry
- [ ] Create-time abort releases slot
- [ ] Queue timeout returns explicit error
- [ ] Queue timeout maps to retryable capacity semantics
- [ ] Client disconnect/admission abort maps to cancellation/incomplete, not capacity pressure
- [ ] Shutdown drain maps to service-lifecycle unavailable semantics when a wire response is possible
- [ ] Shutdown drains queued admissions
- [ ] Admission timeout releases active-turn capacity via terminal turn result/event
- [ ] Admission abort releases active-turn capacity via terminal turn result/event
- [ ] Shutdown drain releases active-turn capacity via terminal turn result/event when a turn record exists

## PR 5: ACP worker observability and idle reaper

- [ ] Add worker/admission snapshot or metrics provider seam
- [ ] Expose active/creating/idle worker counts
- [ ] Expose admission queue depth and outcome counts
- [ ] Add background idle reaper
- [ ] Add structured admission/reaper logs
- [ ] Add tests for metrics and idle cleanup
- [ ] Update operations docs

Acceptance evidence:

- [ ] `/metrics` includes non-secret worker pressure fields
- [ ] Structured admission/reaper logs include no prompts, tokens, raw ACP frames, or local secret paths
- [ ] Idle worker is reaped without a new request
- [ ] Idle reaper does not interfere with active workers or admission accounting
- [ ] Shutdown stops accepting new turns/admissions before drain begins
- [ ] New turns/admissions after shutdown stop-accepting use service-lifecycle unavailable semantics
- [ ] Shutdown drains queues and active work according to timeout semantics
- [ ] Shutdown flushes or safely closes the event journal after terminal cleanup is recorded

## PR 6: HTTP app boundary cleanup

- [ ] Extract stream lifecycle observer
- [ ] Extract journal wrapper
- [ ] Extract metrics collector
- [ ] Move OpenAI Responses error encoding into adapter package
- [ ] Extract route handlers incrementally
- [ ] Preserve current behavior with server/integration tests

Acceptance evidence:

- [ ] Route/status/SSE behavior unchanged
- [ ] OpenAI error body encoding no longer lives in generic app transport logic
- [ ] No unrelated runtime behavior changes

## PR 7: Event-driven approval wait

- [ ] Add in-process approval notification path
- [ ] Preserve SQLite polling fallback
- [ ] Preserve timeout and abort behavior
- [ ] Add same-process wake tests
- [ ] Add restart/cross-process fallback tests or documented surrogate

Acceptance evidence:

- [ ] Same-process decision wakes without polling delay
- [ ] Polling fallback still observes SQLite decisions
- [ ] Terminal approval states remain durable and idempotent

## PR 8: Capabilities endpoint

- [ ] Design minimal public capability projection from internal registry
- [ ] Add versioned, non-secret endpoint
- [ ] Add `Cache-Control: no-store`
- [ ] Represent ACP native cancel support as classified observation, not boolean overclaim
- [ ] Add no-secret/path leakage tests
- [ ] Update docs

Acceptance evidence:

- [ ] Endpoint returns versioned projection
- [ ] Response uses `Cache-Control: no-store`
- [ ] Output contains no tokens, raw ACP payloads, or local secret paths
- [ ] ACP native cancel support is classified, not represented as an overclaiming boolean
- [ ] Adapter-specific projection does not pollute core registry

## PR 9: SSE resume and AgentEvent schema design

- [ ] Define event ID format
- [ ] Define `Last-Event-ID` replay semantics
- [ ] Define terminal-event idempotency rules
- [ ] Define journal envelope version/upcaster strategy
- [ ] Define migration/test strategy for prior journal versions
- [ ] Review design with latest available Claude xhigh and GPT high-reasoning models

Acceptance evidence:

- [ ] Design approved before implementation
- [ ] Future tests cover no duplicate/skipped terminal events
- [ ] Future tests cover at least one prior schema version

## Deferred / explicitly out of scope for this plan

- Production model router
- Full tool-call broker
- ACP permission callback translator into control-plane approval pipeline
- Thread/Turn/BackendSession manager extraction from `DurableSessionManager`
- MCP server surface
- AG-UI northbound adapter
- A2A federation
- Full ACP SDK runtime replacement
- SSE resume implementation
- Enterprise/shared-deployment content policy provider

## Final validation before declaring the plan complete

- [ ] `plans/refine-arch/plan.md` reviewed against `arch.md` and `design.md`
- [ ] `plans/refine-arch/todo.md` mirrors the approved PR sequence
- [ ] SQL todos reflect the same PR sequence and dependencies
- [ ] Gate 2 approval received before implementation starts
