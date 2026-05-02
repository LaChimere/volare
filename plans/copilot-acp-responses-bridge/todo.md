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

- [x] Add core interfaces and canonical types.
  - **Acceptance criteria**: `NorthboundAdapterInterface`, `AgentBackendInterface`, canonical request/event types, and protocol-neutral errors exist without Codex/OpenAI branching in core. All TypeScript interfaces use the explicit `Interface` suffix; concrete implementations do not use that suffix.
  - **Expected evidence**: `bun run check` passed. Core files: `src/core/types.ts`, `src/core/errors.ts`; `rg 'interface [A-Za-z]+\b' src tests scripts` shows all TypeScript interface declarations use the explicit `Interface` suffix.
- [x] Implement bearer auth and local HTTP server defaults.
  - **Acceptance criteria**: Server binds to `127.0.0.1` by default, CORS is disabled by default, and all endpoints require bearer auth before serving requests. Startup accepts `AGENT_LOOM_API_KEY` or generates an ephemeral token, rejects clearly too-short user-provided tokens before HTTP bind, and generated tokens have at least 128 bits of entropy.
  - **Expected evidence**: `bun run check` and `bun run test:unit` passed. Tests cover unauthenticated rejection, token startup validation, generated token shape through `createServerRuntimeConfig()`, and local server defaults in `src/server/config.ts`.
- [x] Implement minimal OpenAI Responses routes.
  - **Acceptance criteria**: `GET /openai/v1/models`, `POST /openai/v1/responses`, and `GET /openai/v1/responses/:id` support the minimal authenticated flow. `POST /responses` streams a single text-only SSE response; `GET /responses/:id` returns terminal and non-terminal snapshots without blocking.
  - **Expected evidence**: `tests/unit_tests/server/app.test.ts` covers models, response creation/streaming, terminal stored response retrieval, non-terminal stored response retrieval without blocking, unsupported tools, and explicit Phase 1 `previous_response_id` rejection.
- [x] Implement OpenAI Responses stored response encoding.
  - **Acceptance criteria**: `NorthboundAdapterInterface.encodeStoredResponse()` encodes `TurnRecordInterface` plus accumulated canonical events for terminal and non-terminal turns.
  - **Expected evidence**: `tests/unit_tests/northbound/openai-responses-adapter.test.ts` covers completed and running stored response snapshots; server route tests cover failed unsupported parameter responses.
- [x] Implement minimal turn/event tracking for the single-turn bridge.
  - **Acceptance criteria**: Phase 1 stores enough turn and event state to serve streaming plus `GET /responses/:id` in a single process. Durable SQLite schema and multi-turn continuity remain Phase 2 scope.
  - **Expected evidence**: `src/core/in-memory-session-manager.ts` stores turn/event state in memory only; server route tests retrieve `GET /responses/:id` before and after stream completion.
- [x] Implement MVP workspace resolver.
  - **Acceptance criteria**: Selected workspace root is canonicalized and constrained to cwd/single configured root or allowlist.
  - **Expected evidence**: `tests/unit_tests/core/workspace-resolver.test.ts` covers configured root canonicalization and allowlist forbidden roots.
- [x] Implement the first concrete Copilot backend adapter for the single-turn path.
  - **Acceptance criteria**: Based on Phase 0 findings, implement only the concrete backend behavior needed for startup/session creation, single prompt send, streaming text, and basic cancellation. Multi-turn resume, approval behavior, and hardening stay in later phases.
  - **Expected evidence**: `src/backends/copilot-cli/backend.ts` implements `CopilotCliBackend` with `Bun.spawn()` runner, Phase 0 backend-internal approval capability metadata, session creation, prompt send, streaming text extraction, cancellation hooks, and disposal hooks. `tests/unit_tests/backends/copilot-cli-backend.test.ts` covers backend capabilities, session creation plus one prompt send through an injected runner, and Copilot output parsing.
- [x] Add `MockBackend` tests for the minimal bridge.
  - **Acceptance criteria**: Tests cover auth rejection, request parsing, basic SSE encoding, unsupported parameters, and Phase 0 approval capability metadata shape only. Do not implement approval behavior in Phase 1.
  - **Expected evidence**: `tests/unit_tests/backends/mock-backend.test.ts`, `tests/unit_tests/northbound/openai-responses-adapter.test.ts`, and `tests/unit_tests/server/app.test.ts` cover the Phase 1 MockBackend route/adapter behavior.

### Phase 2: Multi-turn State

- [x] Add SQLite schema and first migration.
  - **Acceptance criteria**: Workspace, thread, turn, client ref, backend session, event, approval, and schema version tables match `design.md`.
  - **Expected evidence**: `src/state/migrations.ts` creates workspaces, threads, turns, client_turn_refs, backend_sessions, events, approvals, indexes, and schema_version. `tests/unit_tests/state/sqlite-store.test.ts` inspects the table list.
- [x] Add SQLite migration tests.
  - **Acceptance criteria**: Schema creation is idempotent, foreign keys are enforced, unique constraints work, required indexes exist, and `schema_version` tracks applied migrations.
  - **Expected evidence**: `bun run check` and `bun run test:unit` passed; migration tests cover idempotent migration, `PRAGMA foreign_keys`, table creation, and schema version tracking.
- [x] Implement `StateStoreInterface`.
  - **Acceptance criteria**: Atomic workspace get-or-create with `UNIQUE(root_path)` constraint enforcement and retry lookup on unique-constraint conflicts, queued turn creation, compare-and-set turn status updates, backend session reserve/activate/status updates, and client ref lookup work.
  - **Expected evidence**: `src/state/sqlite-store.ts` implements `StateStoreInterface`; unit tests cover workspace get-or-create, queued turn creation, compare-and-set turn updates, backend reserve/activate/status updates, and client ref bind/lookup.
- [x] Implement backend session reserve/activate failure handling.
  - **Acceptance criteria**: `reserveBackendSession()` creates an `initializing` row before runtime start; `activateBackendSession()` records backend metadata; activation failures mark sessions `lost` or `abandoned` without reusing the thread.
  - **Expected evidence**: `SQLiteStateStore` tests cover initializing->active and activation CAS failure; `DurableSessionManager` tests cover failed backend start marking a reserved session `lost`.
- [x] Implement `SessionManagerInterface`.
  - **Acceptance criteria**: It owns core turn start/cancel flows, backend session creation and resumption including `AgentBackendInterface.resumeSession()` calls, backend session continuity, terminal-event guarantees, adapter-independent orchestration, and workspace re-canonicalization before backend session resume. `SessionManagerInterface.startTurn()` returns `ResolvedTurnInterface` containing turn/thread/session/request and wraps `AgentBackendInterface.send()` in `try/finally`, expects the backend to emit a terminal event when it can, and synthesizes exactly one terminal event if the backend throws, exits early, times out, or omits a terminal event. Before every send/resume/cancel operation, it validates `session.workspaceId === request.workspaceId` and `session.threadId === request.threadId`. If the persisted workspace path is missing or resolves differently during resume, it fails with `workspace_changed`.
  - **Expected evidence**: `DurableSessionManager` tests cover backend reserve/activate, `resumeSession()` reuse, terminal-event synthesis, cancel delegation, workspace/thread scope rejection, and `workspace_changed` resume failures.
- [x] Implement backend workspace re-canonicalization in `createSession()`.
  - **Acceptance criteria**: Process-backed backends re-canonicalize `workspace.rootPath` immediately before setting child process cwd in `createSession()` and fail with `workspace_canonicalization_failed` if it no longer matches the resolved workspace.
  - **Expected evidence**: `CopilotCliBackend` tests create sessions from canonical temp workspaces and fail when the workspace disappears before spawn.
- [x] Implement `previous_response_id` continuity.
  - **Acceptance criteria**: OpenAI response IDs map to canonical parent turn/thread state and reuse the correct backend session.
  - **Expected evidence**: Server route tests verify a second Responses request resolves the previous external response ID to the same thread/backend session and parent turn.
- [x] Add multi-turn state tests.
  - **Acceptance criteria**: Tests prove continuation, missing parent handling, workspace/session mismatch rejection, and session-lost behavior.
  - **Expected evidence**: `bun run test` passed with durable continuation, missing parent, and session-lost route tests plus session-manager resume/terminal synthesis tests.

### Phase 3: Permissions and Cancellation

- [x] Confirm the Phase 3 approval gate.
  - **Acceptance criteria**: Phase 0's approval decision is documented, design Open Question #7 is resolved for the MVP, and the result is reflected in concrete backend behavior plus `MockBackend` approval capability shape before any Phase 3 implementation starts.
  - **Expected evidence**: `plan.md` records the Phase 0 decision as backend-internal pause/resume with `externalApprovalDecisions: false`; backend capability tests assert the same metadata.
- [x] Implement approval policy defaults.
  - **Acceptance criteria**: Read-only actions allow, writes and shell ask, destructive actions deny by default.
  - **Expected evidence**: `tests/unit_tests/approvals/policy.test.ts` covers read allow, write/shell ask, destructive deny, and default deny behavior.
- [x] Implement approval path canonicalization and workspace boundary enforcement.
  - **Acceptance criteria**: File paths in permission requests are canonicalized with platform-native realpath before approval; paths outside the workspace auto-deny with `path_outside_workspace`; canonicalization failures auto-deny with `path_canonicalization_failed`.
  - **Expected evidence**: Approval policy tests cover canonical relative paths, symlink escape denial, outside-workspace denial, and canonicalization failures.
- [x] Implement `ApprovalProviderInterface` persistence and atomic resolution.
  - **Acceptance criteria**: Approval status update and `permission.resolved` journal append commit atomically through `StateStoreInterface.resolveApprovalWithJournal()` for allow, deny, timeout, and cancellation paths. If the journal append cannot commit, the approval remains pending or the turn fails closed with `turn.failed`; never continue with an unjournaled decision.
  - **Expected evidence**: `SQLiteStateStore` transaction tests cover atomic approval resolution and rollback on journal insertion failure; `ApprovalProvider` tests cover persisted ask evaluations and canonical `permission.resolved` journal events.
- [x] Implement `ApprovalProviderInterface.awaitDecision()` AbortSignal cancellation.
  - **Acceptance criteria**: When turn-cancellation `AbortSignal` fires, `awaitDecision()` atomically resolves the approval as deny with reason `turn_cancelled`, appends `permission.resolved` in the same transaction, returns `{ type: "aborted" }`, and makes subsequent approval attempts idempotent no-ops.
  - **Expected evidence**: `ApprovalProvider` tests cover AbortSignal cancellation resolving to `{ type: "aborted", reason: "turn_cancelled" }`, persisted aborted state, and idempotent later resolution attempts.
- [x] Implement approval API and backend decision delivery.
  - **Acceptance criteria**: Behavior matches the Phase 0 decision and design Open Question #7 resolution, and does not claim approval enforcement without backend support. If HTTP approval UI is not in MVP, this means internal `ApprovalProviderInterface` API plus backend integration only.
  - **Expected evidence**: `DurableSessionManager` backend interaction tests cover supported external approval delivery and fail-closed behavior when a backend emits `permission.required` without advertising external approval decision support; Copilot capability metadata still reports external approval decisions as unsupported.
- [x] Implement approval audit trail.
  - **Acceptance criteria**: `permission.required` and `permission.resolved` events are journaled for allow, deny, timeout, and cancellation paths; audit event completeness is testable before the Phase 4 debug endpoint exposes the events.
  - **Expected evidence**: `ApprovalProvider` tests assert complete approval audit event pairs for manual allow, manual deny, timeout, and cancellation paths, including idempotent terminal resolution behavior.
- [x] Implement approval timeout watchdog and escalation.
  - **Acceptance criteria**: After timeout auto-deny is journaled, `SessionManagerInterface` waits up to `cancel_timeout_ms` for a backend terminal event; if none arrives, it atomically checks the turn is non-terminal, calls `AgentBackendInterface.cancel(session, { forceAfterTimeout: true })`, synthesizes `turn.interrupted` with reason `approval_timeout_exceeded`, and marks the backend session abandoned after forced disposal if needed.
  - **Expected evidence**: `DurableSessionManager` tests cover backend terminal-before-timeout through the supported approval-delivery path, plus forced cancel after timeout, synthesized `turn.interrupted` with reason `approval_timeout_exceeded`, and abandoned session marking.
- [x] Implement the Responses cancel endpoint route.
  - **Acceptance criteria**: `POST /openai/v1/responses/:id/cancel` requires auth, resolves external response ID to turn ID, calls `SessionManagerInterface.cancelTurn()`, and returns appropriate success/error responses for authenticated cancel, unauthenticated rejection, missing response ID, already-terminal turn, and concurrent cancel.
  - **Expected evidence**: Server route tests cover authenticated cancel, unauthenticated rejection, missing response ID, already-terminal turn preservation, concurrent cancel idempotency, and SSE stream disconnect cancellation.
- [x] Implement cancellation endpoint and SSE disconnect cancellation.
  - **Acceptance criteria**: Cancellation is idempotent, uses compare-and-set status changes, and always reaches a terminal turn state. SSE disconnect waits `disconnect_grace_ms` before transitioning the turn to `cancelling`; MVP does not add stream-reconnect machinery because the current Responses surface has no resumable SSE channel. If force-cancel exceeds `cancel_timeout_ms`, mark the turn `interrupted` with reason `force_cancel_timeout_exceeded` and mark the backend session abandoned.
  - **Expected evidence**: Cancel endpoint and disconnect tests cover repeated/concurrent cancellation, in-grace non-terminal state before disconnect cancellation, cancellation after grace expires, and durable force-cancel timeout reason `force_cancel_timeout_exceeded`.
- [x] Implement force-dispose process cleanup.
  - **Acceptance criteria**: Timeout escalation calls backend cleanup, marks sessions disposed/abandoned from `SessionManagerInterface`, and does not leave reusable abandoned sessions. Process-backed backends escalate disposal with SIGTERM first, then SIGKILL if the process remains alive after the shutdown budget.
  - **Expected evidence**: `DurableSessionManager` tests cover backend cancel timeout causing forced disposal, turn interruption, and abandoned session marking; `CopilotCliBackend` tests cover cleanup delegation, and `BunCopilotPromptRunner` tracks all active session processes for SIGTERM/SIGKILL cleanup.
- [x] Add cancellation and approval timeout tests.
  - **Acceptance criteria**: Tests cover concurrent cancel idempotency and approval timeout terminal-state guarantees.
  - **Expected evidence**: Server tests cover concurrent cancel idempotency and SSE disconnect cancellation; `DurableSessionManager` tests cover cancel timeout interruption and approval-timeout terminal-state guarantees.

### Phase 4: Event Journal and Minimal Debugging

- [x] Implement canonical event journal and replay.
  - **Acceptance criteria**: Replay orders by sequence, detects gaps, and supports incomplete non-terminal turns without treating them as corruption.
  - **Expected evidence**: `SQLiteEventJournal` replay tests cover ordered replay, sequence gap detection, incomplete non-terminal replay, thread listing, and malformed canonical JSON corruption errors.
- [x] Implement redaction boundary.
  - **Acceptance criteria**: Headers, file contents, commands, URLs, env vars, prompts, and approval payloads follow redaction rules before persistence.
  - **Expected evidence**: `DefaultRedactor` tests cover sensitive headers, file contents, shell commands, URLs, environment variables, prompts, and approval payloads; `SQLiteEventJournal` tests verify redacted payloads are persisted.
- [x] Implement fail-closed redaction behavior.
  - **Acceptance criteria**: `RedactionFailedError` prevents unredacted persistence and fails the active turn safely.
  - **Expected evidence**: `SQLiteEventJournal` simulated redaction failure test verifies the original unredacted payload is not persisted and only a sanitized security `turn.failed` event is written before `RedactionFailedError` is returned.
- [x] Add the minimal debug endpoint.
  - **Acceptance criteria**: A single authenticated, read-only `GET /debug/turns/:id/events` endpoint exposes redacted turn events without leaking secrets. Do not add broader observability, UI, thread debug routes, backend-session debug routes, or approval debug routes in this phase.
  - **Expected evidence**: Server route tests cover authenticated `GET /debug/turns/:id/events`, redacted event payloads, and unauthenticated rejection.
- [x] Add golden replay tests.
  - **Acceptance criteria**: Tests cover backend events to canonical events to encoded OpenAI SSE output.
  - **Expected evidence**: `OpenAIResponsesAdapter` golden replay test writes canonical events to `SQLiteEventJournal`, replays them, encodes OpenAI Responses SSE output, and verifies the completed response contains replayed text.

### Phase 5A: Recovery and Cleanup Hardening

- [x] Implement startup recovery.
  - **Acceptance criteria**: Recovery completes before HTTP bind, non-terminal turns are interrupted, and active/stale backend sessions are handled according to design.
  - **Expected evidence**: `src/index.ts` runs `SQLiteStateStore.recoverStartupState()` before `Bun.serve()`, and SQLite recovery tests verify non-terminal turns are interrupted, terminal turns are preserved, and active/stale backend sessions are abandoned idempotently.
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
