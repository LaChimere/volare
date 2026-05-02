# Task Checklist

> Purpose: execution-phase checklist derived from `plans/copilot-acp-responses-bridge/plan.md`.
> Treat this as the progress truth source once the plan is approved.

## Task

- **Summary**: Implement Agent Loom's MVP bridge from Codex/OpenAI Responses to a Copilot-backed agent runtime.
- **Links**:
  - `plans/copilot-acp-responses-bridge/research.md`
  - `plans/copilot-acp-responses-bridge/design.md`
  - `plans/copilot-acp-responses-bridge/plan.md`

## Plan Reference

- **Plan version/date**: Initial execution plan, 2026-05-02
- **Approved by**: User execution instruction on 2026-05-02

## Checklist

### Preparation

- [x] Confirm baseline branch and working tree before implementation.
  - **Acceptance criteria**: Existing unrelated changes are identified and not reverted.
  - **Expected evidence**: `git --no-pager status --short --branch` showed `## main...origin/main` and untracked `plans/` planning artifacts only.
- [x] Confirm Bun project/package scaffolding and available scripts.
  - **Acceptance criteria**: Known commands for tests/build/typecheck are recorded before coding.
  - **Expected evidence**: `package.json` includes `check`, `typecheck`, `test`, `test:unit`, `test:integration`, and `ci`; baseline `bun run check` passed and `bun run test` passed with no tests present.
- [x] Confirm verification target.
  - **Acceptance criteria**: Overall target is L2, with L3 only when real Codex + Copilot integration is available.
  - **Expected evidence**: Overall target remains L2; L3 is gated on real Codex + Copilot integration availability.
- [x] Re-read `design.md` and this checklist before starting implementation.
  - **Acceptance criteria**: No implementation starts from stale assumptions.
  - **Expected evidence**: Current `design.md`, `plan.md`, and this checklist were re-read before Phase 0 execution.

### Phase 0: Protocol Probe

- [x] Create a throwaway Copilot backend lifecycle probe.
  - **Acceptance criteria**: Probe covers backend startup, initialization, session creation, prompt send, streaming text, cancellation, and approval behavior.
  - **Expected evidence**: `bun scripts/probe-copilot-cli.ts` reported `copilot` at `/opt/homebrew/bin/copilot`, version `GitHub Copilot CLI 1.0.40`, supported backend startup, ACP server startup, ACP initialize, prompt send, streaming text, process-level cancellation, and permission flags. External approval decision delivery was not proven.
- [x] Record the approval integration decision.
  - **Acceptance criteria**: Decision is one of external decisions, backend-internal pause/resume, or approvals unsupported for first backend.
  - **Expected evidence**: `plan.md` Phase 0 Findings chooses backend-internal pause/resume for the first backend and explicitly says not to claim HTTP/external approval enforcement until Phase 3 proves an ACP approval decision method.
- [x] Record the approval capability metadata shape.
  - **Acceptance criteria**: The Phase 0 decision note defines the `MockBackend` approval capability metadata shape that Phase 1 may assert without implementing approval behavior.
  - **Expected evidence**: `plan.md` records `permissionRequests: true`, `externalApprovalDecisions: false`, `backendInternalPauseResume: true`, and `decision: "backend-internal-pause-resume"` for Phase 1 `MockBackend` metadata.
- [x] Update `design.md` or `plan.md` if probe findings invalidate assumptions.
  - **Acceptance criteria**: Later phases do not proceed on disproven backend assumptions.
  - **Expected evidence**: `plan.md` assumptions and Phase 0 Findings were updated; no `design.md` change was needed because the design already allows the Phase 0 approval path decision.

### Phase 1: Minimal Responses Bridge

- [ ] Add core interfaces and canonical types.
  - **Acceptance criteria**: `NorthboundAdapterInterface`, `AgentBackendInterface`, canonical request/event types, and protocol-neutral errors exist without Codex/OpenAI branching in core. All TypeScript interfaces use the explicit `Interface` suffix; concrete implementations do not use that suffix.
  - **Expected evidence**: Typecheck/test output and file list for core interface modules.
- [ ] Implement bearer auth and local HTTP server defaults.
  - **Acceptance criteria**: Server binds to `127.0.0.1` by default, CORS is disabled by default, and all endpoints require bearer auth before serving requests. Startup accepts `AGENT_LOOM_API_KEY` or generates an ephemeral token, rejects clearly too-short user-provided tokens before HTTP bind, and generated tokens have at least 128 bits of entropy.
  - **Expected evidence**: Auth rejection route test output, token startup validation tests, ephemeral token generation test or inspection, CORS-disabled/default-origin rejection tests, and config/defaults test output.
- [ ] Implement minimal OpenAI Responses routes.
  - **Acceptance criteria**: `GET /openai/v1/models`, `POST /openai/v1/responses`, and `GET /openai/v1/responses/:id` support the minimal authenticated flow. `POST /responses` streams a single text-only SSE response; `GET /responses/:id` returns terminal and non-terminal snapshots without blocking.
  - **Expected evidence**: Route test output for models, response creation/streaming, and stored response retrieval.
- [ ] Implement OpenAI Responses stored response encoding.
  - **Acceptance criteria**: `NorthboundAdapterInterface.encodeStoredResponse()` encodes `TurnRecordInterface` plus accumulated canonical events for terminal and non-terminal turns.
  - **Expected evidence**: Stored response encoding tests covering completed, running, failed, cancelled, and interrupted turns.
- [ ] Implement minimal turn/event tracking for the single-turn bridge.
  - **Acceptance criteria**: Phase 1 stores enough turn and event state to serve streaming plus `GET /responses/:id` in a single process. Durable SQLite schema and multi-turn continuity remain Phase 2 scope.
  - **Expected evidence**: Route tests showing `POST /responses` events can be retrieved by `GET /responses/:id` before and after completion without adding SQLite dependencies.
- [ ] Implement MVP workspace resolver.
  - **Acceptance criteria**: Selected workspace root is canonicalized and constrained to cwd/single configured root or allowlist.
  - **Expected evidence**: Workspace resolver tests covering cwd/configured root, allowlist acceptance, and forbidden roots.
- [ ] Implement the first concrete Copilot backend adapter for the single-turn path.
  - **Acceptance criteria**: Based on Phase 0 findings, implement only the concrete backend behavior needed for startup/session creation, single prompt send, streaming text, and basic cancellation. Multi-turn resume, approval behavior, and hardening stay in later phases.
  - **Expected evidence**: Feature-gated integration proof or backend adapter test showing real backend startup/session creation, one prompt send, streaming text, and basic cancellation.
- [ ] Add `MockBackend` tests for the minimal bridge.
  - **Acceptance criteria**: Tests cover auth rejection, request parsing, basic SSE encoding, unsupported parameters, and Phase 0 approval capability metadata shape only. Do not implement approval behavior in Phase 1.
  - **Expected evidence**: `bun test` excerpt for MockBackend route/adapter tests.

### Phase 2: Multi-turn State

- [ ] Add SQLite schema and first migration.
  - **Acceptance criteria**: Workspace, thread, turn, client ref, backend session, event, approval, and schema version tables match `design.md`.
  - **Expected evidence**: Migration test output or schema inspection output.
- [ ] Add SQLite migration tests.
  - **Acceptance criteria**: Schema creation is idempotent, foreign keys are enforced, unique constraints work, required indexes exist, and `schema_version` tracks applied migrations.
  - **Expected evidence**: Migration compatibility test output.
- [ ] Implement `StateStoreInterface`.
  - **Acceptance criteria**: Atomic workspace get-or-create with `UNIQUE(root_path)` constraint enforcement and retry lookup on unique-constraint conflicts, queued turn creation, compare-and-set turn status updates, backend session reserve/activate/status updates, and client ref lookup work.
  - **Expected evidence**: StateStoreInterface unit tests for each persistence invariant.
- [ ] Implement backend session reserve/activate failure handling.
  - **Acceptance criteria**: `reserveBackendSession()` creates an `initializing` row before runtime start; `activateBackendSession()` records backend metadata; activation failures mark sessions `lost` or `abandoned` without reusing the thread.
  - **Expected evidence**: StateStoreInterface/SessionManagerInterface tests for initializing->active and failure transitions.
- [ ] Implement `SessionManagerInterface`.
  - **Acceptance criteria**: It owns core turn start/cancel flows, backend session creation and resumption including `AgentBackendInterface.resumeSession()` calls, backend session continuity, terminal-event guarantees, adapter-independent orchestration, and workspace re-canonicalization before backend session resume. `SessionManagerInterface.startTurn()` returns `ResolvedTurnInterface` containing turn/thread/session/request and wraps `AgentBackendInterface.send()` in `try/finally`, expects the backend to emit a terminal event when it can, and synthesizes exactly one terminal event if the backend throws, exits early, times out, or omits a terminal event. Before every send/resume/cancel operation, it validates `session.workspaceId === request.workspaceId` and `session.threadId === request.threadId`. If the persisted workspace path is missing or resolves differently during resume, it fails with `workspace_changed`.
  - **Expected evidence**: SessionManagerInterface tests covering `ResolvedTurnInterface`, `AgentBackendInterface.resumeSession()` calls, send/resume/cancel workspace and thread mismatch rejection, terminal-event synthesis, and `workspace_changed` resume failures.
- [ ] Implement backend workspace re-canonicalization in `createSession()`.
  - **Acceptance criteria**: Process-backed backends re-canonicalize `workspace.rootPath` immediately before setting child process cwd in `createSession()` and fail with `workspace_canonicalization_failed` if it no longer matches the resolved workspace.
  - **Expected evidence**: Backend adapter tests simulating workspace path changes between resolution and process spawn.
- [ ] Implement `previous_response_id` continuity.
  - **Acceptance criteria**: OpenAI response IDs map to canonical parent turn/thread state and reuse the correct backend session.
  - **Expected evidence**: Multi-turn adapter tests showing response ID to thread/session continuity.
- [ ] Add multi-turn state tests.
  - **Acceptance criteria**: Tests prove continuation, missing parent handling, workspace/session mismatch rejection, and session-lost behavior.
  - **Expected evidence**: `bun test` excerpt for multi-turn state cases.

### Phase 3: Permissions and Cancellation

- [ ] Confirm the Phase 3 approval gate.
  - **Acceptance criteria**: Phase 0's approval decision is documented, design Open Question #7 is resolved for the MVP, and the result is reflected in concrete backend behavior plus `MockBackend` approval capability shape before any Phase 3 implementation starts.
  - **Expected evidence**: Decision note naming HTTP approval UI vs internal-only approval API, plus backend/MockBackend capability test output.
- [ ] Implement approval policy defaults.
  - **Acceptance criteria**: Read-only actions allow, writes and shell ask, destructive actions deny by default.
  - **Expected evidence**: Policy unit test output.
- [ ] Implement approval path canonicalization and workspace boundary enforcement.
  - **Acceptance criteria**: File paths in permission requests are canonicalized with platform-native realpath before approval; paths outside the workspace auto-deny with `path_outside_workspace`; canonicalization failures auto-deny with `path_canonicalization_failed`.
  - **Expected evidence**: Approval path tests covering `..`, symlinks, mixed separators, absolute paths, outside-workspace paths, and canonicalization failures.
- [ ] Implement `ApprovalProviderInterface` persistence and atomic resolution.
  - **Acceptance criteria**: Approval status update and `permission.resolved` journal append commit atomically through `StateStoreInterface.resolveApprovalWithJournal()` for allow, deny, timeout, and cancellation paths. If the journal append cannot commit, the approval remains pending or the turn fails closed with `turn.failed`; never continue with an unjournaled decision.
  - **Expected evidence**: ApprovalProviderInterface transaction tests including simulated journal failure.
- [ ] Implement `ApprovalProviderInterface.awaitDecision()` AbortSignal cancellation.
  - **Acceptance criteria**: When turn-cancellation `AbortSignal` fires, `awaitDecision()` atomically resolves the approval as deny with reason `turn_cancelled`, appends `permission.resolved` in the same transaction, returns `{ type: "aborted" }`, and makes subsequent approval attempts idempotent no-ops.
  - **Expected evidence**: ApprovalProviderInterface tests covering AbortSignal cancellation, transaction atomicity, and subsequent duplicate approval attempts.
- [ ] Implement approval API and backend decision delivery.
  - **Acceptance criteria**: Behavior matches the Phase 0 decision and design Open Question #7 resolution, and does not claim approval enforcement without backend support. If HTTP approval UI is not in MVP, this means internal `ApprovalProviderInterface` API plus backend integration only.
  - **Expected evidence**: Route/backend interaction tests for allow, deny, timeout, and unsupported approval behavior.
- [ ] Implement approval audit trail.
  - **Acceptance criteria**: `permission.required` and `permission.resolved` events are journaled for allow, deny, timeout, and cancellation paths; audit event completeness is testable before the Phase 4 debug endpoint exposes the events.
  - **Expected evidence**: Event journal tests showing complete approval audit event pairs for allow, deny, timeout, cancellation, and unsupported approval behavior.
- [ ] Implement approval timeout watchdog and escalation.
  - **Acceptance criteria**: After timeout auto-deny is journaled, `SessionManagerInterface` waits up to `cancel_timeout_ms` for a backend terminal event; if none arrives, it atomically checks the turn is non-terminal, calls `AgentBackendInterface.cancel(session, { forceAfterTimeout: true })`, synthesizes `turn.interrupted` with reason `approval_timeout_exceeded`, and marks the backend session abandoned after forced disposal if needed.
  - **Expected evidence**: Approval timeout tests covering backend terminal-before-timeout, forced cancel after timeout, synthesized interrupted event, and abandoned session marking.
- [ ] Implement the Responses cancel endpoint route.
  - **Acceptance criteria**: `POST /openai/v1/responses/:id/cancel` requires auth, resolves external response ID to turn ID, calls `SessionManagerInterface.cancelTurn()`, and returns appropriate success/error responses for authenticated cancel, unauthenticated rejection, missing response ID, already-terminal turn, and concurrent cancel.
  - **Expected evidence**: Route tests for authenticated cancel, unauthenticated rejection, missing response ID, already-terminal turn, and concurrent cancel idempotency.
- [ ] Implement cancellation endpoint and SSE disconnect cancellation.
  - **Acceptance criteria**: Cancellation is idempotent, uses compare-and-set status changes, and always reaches a terminal turn state. SSE disconnect waits `disconnect_grace_ms` before transitioning the turn to `cancelling`, and cancellation proceeds only if the client does not reconnect within the grace period. If force-cancel exceeds `cancel_timeout_ms`, mark the turn `interrupted` with reason `force_cancel_timeout_exceeded` and mark the backend session abandoned.
  - **Expected evidence**: Cancel endpoint and disconnect tests including repeated/concurrent cancellation, reconnect within grace period, cancellation after grace period expires, and force-cancel timeout reason `force_cancel_timeout_exceeded`.
- [ ] Implement force-dispose process cleanup.
  - **Acceptance criteria**: Timeout escalation calls backend cleanup, marks sessions disposed/abandoned from `SessionManagerInterface`, and does not leave reusable abandoned sessions. Process-backed backends escalate disposal with SIGTERM first, then SIGKILL if the process remains alive after the shutdown budget.
  - **Expected evidence**: Process-backed backend cleanup tests or feature-gated integration proof.
- [ ] Add cancellation and approval timeout tests.
  - **Acceptance criteria**: Tests cover concurrent cancel idempotency and approval timeout terminal-state guarantees.
  - **Expected evidence**: `bun test` excerpt for cancellation/approval timeout cases.

### Phase 4: Event Journal and Minimal Debugging

- [ ] Implement canonical event journal and replay.
  - **Acceptance criteria**: Replay orders by sequence, detects gaps, and supports incomplete non-terminal turns without treating them as corruption.
  - **Expected evidence**: EventJournalInterface replay tests including sequence gap and non-terminal replay cases.
- [ ] Implement redaction boundary.
  - **Acceptance criteria**: Headers, file contents, commands, URLs, env vars, prompts, and approval payloads follow redaction rules before persistence.
  - **Expected evidence**: Redaction tests for each sensitive payload class.
- [ ] Implement fail-closed redaction behavior.
  - **Acceptance criteria**: `RedactionFailedError` prevents unredacted persistence and fails the active turn safely.
  - **Expected evidence**: Simulated redaction failure test output.
- [ ] Add the minimal debug endpoint.
  - **Acceptance criteria**: A single authenticated, read-only `GET /debug/turns/:id/events` endpoint exposes redacted turn events without leaking secrets. Do not add broader observability, UI, thread debug routes, backend-session debug routes, or approval debug routes in this phase.
  - **Expected evidence**: Debug route tests showing redacted response payloads.
- [ ] Add golden replay tests.
  - **Acceptance criteria**: Tests cover backend events to canonical events to encoded OpenAI SSE output.
  - **Expected evidence**: Golden fixture test output.

### Phase 5A: Recovery and Cleanup Hardening

- [ ] Implement startup recovery.
  - **Acceptance criteria**: Recovery completes before HTTP bind, non-terminal turns are interrupted, and active/stale backend sessions are handled according to design.
  - **Expected evidence**: Startup recovery tests or integration proof showing server readiness waits for recovery.
- [ ] Implement shutdown orchestration and forced disposal.
  - **Acceptance criteria**: Shutdown stops accepting requests, cancels in-progress turns with `cancel_timeout_ms`, force-disposes unresponsive backends through graceful cancel, SIGTERM, and SIGKILL when supported, marks remaining non-terminal turns interrupted, flushes the event journal, marks abandoned sessions, and exits non-zero if the hard deadline is exceeded.
  - **Expected evidence**: Shutdown tests or integration proof covering graceful shutdown, forced shutdown, abandoned session marking, and journal flush.
- [ ] Add process identity validation.
  - **Acceptance criteria**: Live PIDs are checked against stored identity metadata before any signal is sent.
  - **Expected evidence**: Process identity validation tests covering PID mismatch/reuse scenarios.
- [ ] Implement cleanup and retention.
  - **Acceptance criteria**: Idle session pruning and event retention never delete non-terminal turns. Event retention is disabled by default; if enabled, it deletes only whole terminal-turn journals, writes retention tombstones so replay returns `JournalExpiredError`, and never creates sequence gaps inside retained turns.
  - **Expected evidence**: Cleanup/retention tests showing non-terminal turn preservation, whole-journal deletion, tombstone replay behavior, and no partial sequence gaps.

### Phase 5B: Configuration and Packaging Hardening

- [ ] Add config validation.
  - **Acceptance criteria**: Invalid auth, CORS wildcard, unsafe workspace, timeout, and retention configurations are rejected.
  - **Expected evidence**: Config validation tests for each rejected unsafe setting.
- [ ] Add health checks, metrics, and packaging.
  - **Acceptance criteria**: Health reports recovering/ready states, minimal metrics exist, and Bun packaging works when needed.
  - **Expected evidence**: Health route tests, metrics smoke test, and packaging command output when packaging is introduced.

### Acceptance Gate

- [ ] All acceptance criteria above are met with evidence.
- [ ] Diff remains consistent with approved `plan.md` and does not add out-of-scope protocols/backends.
- [ ] Applicable verification level is executed for each phase.
- [ ] Related docs are checked after behavior, config, schema, or API changes.

If any check fails:

1. Fix directly and re-verify if the gap is straightforward.
2. Update `plan.md` and re-submit for Gate 2 if the plan is incomplete or infeasible.
3. Update `design.md` and re-submit for Gate 1 and Gate 2 if the design is invalid.
4. Stop and report attempted evidence if the issue cannot be resolved safely.

## Verification Evidence

- [ ] Lint/typecheck command:
  - `...`
  - **Expected evidence to paste**: command, exit status, and relevant success/failure excerpt.
- [ ] Unit/contract tests:
  - `bun test`
  - **Expected evidence to paste**: test command, passing summary, and any targeted test names for the completed phase.
- [ ] Integration or before/after checks:
  - Feature-gated real backend integration command TBD after Phase 0.
  - **Expected evidence to paste**: probe/integration command, backend capability notes, or explicit reason integration was not available.
- [ ] Security checks:
  - Auth rejection, CORS rejection, workspace boundary, redaction, approval timeout, cancellation cleanup.
  - **Expected evidence to paste**: targeted test output or scripted before/after proof for each security behavior introduced in the phase.

## Review / Packaging

- [ ] Summarize implementation changes and rationale.
- [ ] Confirm no scope creep or unrelated cleanup.
- [ ] Check whether related docs need updating; use `refresh-related-docs` if broader docs become stale.
- [ ] Prepare PR description or changelog notes if applicable.

## Evidence Log

- `command`: output excerpt
- before/after: evidence

## Result

- **Outcome**:
- **Follow-ups**:
