# Volare architecture refinement todo

## Status

Execution in progress. PR 0 baseline has been captured.

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

- [ ] Add typed active-turn capacity error
- [ ] Enforce `maxActiveSessions` before creating durable turn/session state
- [ ] Map capacity error to HTTP 429 with `Retry-After`, optional millisecond hint, OpenAI `rate_limit_error`, and `code: "capacity_exhausted"`
- [ ] Add unit tests for over-cap concurrency
- [ ] Add tests proving cancel intent alone does not release active-turn capacity
- [ ] Add tests proving terminal events release active-turn capacity exactly once
- [ ] Add tests proving backend cleanup after terminal result does not keep capacity occupied
- [ ] Add server/adapter tests for status/body/headers
- [ ] Update docs if user-visible behavior changes

Acceptance evidence:

- [ ] Over-cap requests fail with typed retryable capacity error
- [ ] No turn/session state is leaked for rejected requests
- [ ] Existing cancellation and streaming tests remain green

## PR 2: Approval resolution

- [ ] Add `IApprovalWaiter` / `IApprovalNotifier` seam with polling implementation
- [ ] Add Volare-specific approval resolution endpoint/path
- [ ] Validate approval ownership using turn/session/approval identifiers
- [ ] Preserve timeout and abort behavior
- [ ] Make duplicate terminal resolution idempotent
- [ ] Ensure shutdown drives pending approvals to a durable terminal state and resolves in-process waiters
- [ ] Record durable terminal approval state before resolving in-process waiters
- [ ] Add approval provider, server, and session-manager tests
- [ ] Document endpoint and operational behavior

Acceptance evidence:

- [ ] Pending approval resolves through API
- [ ] Wrong ownership is rejected
- [ ] Duplicate resolve does not mutate terminal state
- [ ] Timeout still works
- [ ] Shutdown resolves or aborts pending approval waiters to a terminal state
- [ ] Volare-specific approval endpoint errors are non-secret and not OpenAI-specific

## PR 3: Runtime capability registry

- [ ] Add internal runtime/backend capability registry types
- [ ] Aggregate runtime features, backend capabilities, and probe-derived ACP support
- [ ] Add invalidation/update semantics
- [ ] Keep adapter-specific wire projection out of core
- [ ] Add unit tests for merge and invalidation behavior

Acceptance evidence:

- [ ] Registry is internal only
- [ ] No public endpoint added
- [ ] No adapter wire fields leak into core
- [ ] Invalidation triggers cover probe completion/re-run, backend session disposal, runtime mode change, and shutdown

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
