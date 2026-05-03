# Plan

> Purpose: implementation plan for Agent Loom's Codex/OpenAI Responses northbound bridge to a Copilot-backed agent runtime.
> Do not implement until this plan is approved.

## Objective

Build the Agent Loom MVP described in `design.md`: a local, authenticated OpenAI Responses-compatible bridge that lets Codex drive a stateful Copilot-backed coding-agent runtime through protocol-neutral core interfaces.

The implementation should deliver the narrowest useful vertical slice first, then add durable multi-turn state, permissions/cancellation, replayable event journaling, and hardening without adding unsupported client protocols or speculative backends.

## Constraints

- **Compatibility constraints**: The first northbound adapter must be compatible with Codex's OpenAI Responses usage. Core logic must remain protocol-neutral and must not branch on Codex/OpenAI-specific concepts.
- **Runtime constraints**: Use Bun-first implementation choices from `AGENTS.md` and `design.md`: `Bun.serve()`, `bun:sqlite`, `Bun.spawn()`, `bun test`, and `bun run`.
- **Security/safety constraints**: Bind to `127.0.0.1` by default, require bearer-token auth before endpoints accept requests, disable CORS by default, enforce workspace allowlist/cwd boundaries, redact persisted payloads, and fail closed on approval/redaction errors.
- **State constraints**: Preserve continuity through canonical `IThread`, `ITurnRecord`, `IClientTurnRef`, and `IBackendSession` state. Backend session creation must reserve before activation, and status transitions must be compare-and-set guarded.
- **Scope constraints**: Do not implement `/chat/completions`, Anthropic/Gemini adapters, custom UI, full MCP manager, bridge-owned tool execution, remote multi-user deployment, or private/reverse-engineered Copilot APIs in the MVP.

## Assumptions

- [x] **Verified**: `research.md` and `design.md` exist under `plans/copilot-acp-responses-bridge/` and establish the interface-first direction.
- [x] **Verified**: The repo-local guidance prefers Bun and Bun-native APIs.
- [x] **Verified**: Phase 0 must validate the real Copilot backend lifecycle before production backend code is finalized.
- [x] **Verified**: The chosen Copilot CLI integration supports startup, ACP initialize, prompt execution, streaming text, and process-level cancellation in the local environment.
- [ ] **Unverified**: Codex's current Responses client behavior matches the minimal endpoint and SSE shapes in the design.
- [x] **Verified**: The initial repository structure and package scripts contain Bun scaffolding for `check`, `typecheck`, unit tests, integration tests, and CI.

## Options Considered

### Option A: Implement OpenAI Responses directly around Copilot runtime

- **Summary**: Build only the Codex/OpenAI Responses surface and wire it directly to the Copilot backend.
- **Pros**: Fastest first demo.
- **Cons**: Couples core state, cancellation, and approval semantics to one client protocol; makes non-Codex clients harder later.
- **Decision**: Rejected because it conflicts with the interface-first design goal.

### Option B: Interface-first core with one northbound adapter and one backend

- **Summary**: Implement protocol-neutral core interfaces, then add only `OpenAIResponsesAdapter` and one Copilot backend for the MVP.
- **Pros**: Keeps future client/backend flexibility while avoiding speculative adapters.
- **Cons**: Requires careful boundary discipline and slightly more upfront type/state design.
- **Decision**: Chosen.

### Option C: Build a full multi-protocol agent gateway immediately

- **Summary**: Add OpenAI Responses, Chat Completions, Anthropic, Gemini, multiple backends, and broader tool brokering up front.
- **Pros**: Broadest theoretical compatibility.
- **Cons**: Over-designed before the first real backend lifecycle is proven.
- **Decision**: Rejected for MVP.

## Proposed Approach

### Phase 0: Protocol Probe

- [ ] Create a throwaway `scripts/probe-copilot-cli.ts` or equivalent backend probe.
  - **Acceptance criteria**: The probe records whether backend startup, initialization, session creation, prompt send, streaming text, cancellation, and approval behavior are supported.
- [ ] Produce a short backend decision note in this plan or `design.md`.
  - **Acceptance criteria**: The note chooses one approval path for implementation: external decisions through `submitApprovalDecision()`, backend-internal pause/resume, or approvals unsupported for the first backend.
- [ ] Document the approval capability metadata shape for tests.
  - **Acceptance criteria**: The Phase 0 note defines the `MockBackend` approval capability metadata shape that Phase 1 may assert without implementing approval behavior.

#### Phase 0 Findings

Probe command:

```sh
bun scripts/probe-copilot-cli.ts
```

Observed local backend capabilities:

```text
copilot path: /opt/homebrew/bin/copilot
version: GitHub Copilot CLI 1.0.40
backend startup: supported through `copilot --version`
ACP server startup: supported; `copilot --acp` stays alive waiting for client traffic
ACP initialize: supported through a JSON-RPC initialize frame
session creation / prompt send / text response: supported through `copilot --prompt`
streaming text: supported through `copilot --prompt --stream on`
process-level cancellation: supported through SIGTERM of an active prompt process
permission controls: CLI exposes allow/deny permission flags
external approval decision delivery: not proven by this probe
```

Approval integration decision for the first backend: **backend-internal pause/resume**. The concrete backend may rely on Copilot CLI/ACP-native permission behavior for the first implementation, but Agent Loom must not claim HTTP/external approval enforcement until a later Phase 3 probe proves an ACP approval decision method. Phase 1 `MockBackend` approval capability metadata should use:

```json
{
  "permissionRequests": true,
  "externalApprovalDecisions": false,
  "backendInternalPauseResume": true,
  "decision": "backend-internal-pause-resume"
}
```

### Phase 1: Minimal Responses Bridge

- [ ] Establish the Bun project skeleton and core type boundaries.
  - **Acceptance criteria**: `INorthboundAdapter`, `IAgentBackend`, canonical request/event types, and protocol-neutral errors are implemented without concrete protocol leakage. All TypeScript interfaces use the explicit `I` prefix; concrete implementations do not use that prefix.
- [ ] Implement local authenticated HTTP endpoints for the minimal Responses flow.
  - **Acceptance criteria**: `GET /openai/v1/models`, `POST /openai/v1/responses`, and `GET /openai/v1/responses/:id` require bearer auth. Startup accepts `AGENT_LOOM_API_KEY` or generates an ephemeral token, rejects clearly too-short user-provided tokens before HTTP bind, and generated tokens have at least 128 bits of entropy. `POST /responses` can stream a single text-only response through `OpenAIResponsesAdapter`; `GET /responses/:id` returns terminal and non-terminal response snapshots without blocking.
- [ ] Implement stored response encoding in the OpenAI Responses adapter.
  - **Acceptance criteria**: `INorthboundAdapter.encodeStoredResponse()` maps `ITurnRecord` plus accumulated canonical events into the expected OpenAI Responses shape for terminal and non-terminal turns.
- [ ] Implement minimal turn/event tracking for the single-turn bridge.
  - **Acceptance criteria**: Phase 1 stores enough turn and event state to serve streaming plus `GET /responses/:id` in a single process; durable SQLite schema and multi-turn continuity remain Phase 2 scope.
- [ ] Implement MVP workspace resolution.
  - **Acceptance criteria**: The selected workspace root is canonicalized and constrained to single-workspace/cwd or allowlist behavior.
- [ ] Implement the first concrete Copilot backend adapter for the single-turn path.
  - **Acceptance criteria**: Based on Phase 0 findings, implement only the concrete backend behavior needed for startup/session creation, single prompt send, streaming text, and basic cancellation. Multi-turn resume, approval behavior, and hardening stay in later phases.
- [ ] Add `MockBackend` coverage for the minimal bridge.
  - **Acceptance criteria**: Unit/contract tests cover request parsing, auth rejection, basic SSE encoding, unsupported parameters, and the Phase 0 approval capability metadata shape only. Do not implement approval behavior in Phase 1.

### Phase 2: Multi-turn State

- [ ] Implement SQLite-backed state with migration scaffolding.
  - **Acceptance criteria**: `workspaces`, `threads`, `turns`, `client_turn_refs`, `backend_sessions`, `events`, `approvals`, and `schema_version` exist with the constraints defined in `design.md`.
- [ ] Implement `IStateStore` and `ISessionManager`.
  - **Acceptance criteria**: Turns start queued, status changes are compare-and-set guarded, and `getOrCreateWorkspace()` enforces `UNIQUE(root_path)` with retry-on-conflict lookup. Backend sessions reserve before activate, and thread/session continuity is preserved. `ISessionManager.startTurn()` returns `IResolvedTurn` containing turn/thread/session/request, wraps `IAgentBackend.send()` in `try/finally`, expects the backend to emit a terminal event when it can, and synthesizes exactly one terminal event if the backend throws, exits early, times out, or omits a terminal event. `IAgentBackend.resumeSession()` is implemented, rejects reserved sessions with no `backendSessionId`, and is called for continuation. Before every send/resume/cancel operation, `ISessionManager` validates `session.workspaceId === request.workspaceId` and `session.threadId === request.threadId`; it re-canonicalizes persisted workspace roots before backend session resume and fails with `workspace_changed` if the path is missing or resolves differently.
- [ ] Map OpenAI `previous_response_id` to canonical parent turn/thread state.
  - **Acceptance criteria**: Multi-turn tests prove the same backend session is reused and missing/invalid parent refs fail explicitly.

### Phase 3: Permissions and Cancellation

- [ ] Confirm the Phase 3 approval gate before starting implementation.
  - **Acceptance criteria**: Phase 0's approval decision is documented, design Open Question #7 is resolved for the MVP, and the result is reflected in the concrete backend contract plus `MockBackend` approval capability shape.
- [ ] Implement `IApprovalProvider` and policy defaults.
  - **Acceptance criteria**: Reads are allowed, writes/shell ask, destructive actions deny by default, and approval state plus `permission.resolved` journal entries commit atomically through `IStateStore.resolveApprovalWithJournal()`.
- [ ] Implement approval path canonicalization and workspace boundary enforcement.
  - **Acceptance criteria**: File paths in permission requests are canonicalized with platform-native realpath before approval; paths outside the workspace auto-deny with `path_outside_workspace`; canonicalization failures auto-deny with `path_canonicalization_failed`.
- [ ] Implement approval API and backend decision delivery according to the Phase 0 decision.
  - **Acceptance criteria**: Approval allow/deny/timeout/cancel paths block or resume backend execution honestly and never claim enforcement without backend support. If design Open Question #7 resolves to no HTTP approval UI for MVP, this item means the internal `IApprovalProvider` API and backend integration only, not extra HTTP routes.
- [ ] Implement approval timeout and cancellation watchdogs.
  - **Acceptance criteria**: Approval timeout auto-denies and journals `permission.resolved`, waits up to `cancel_timeout_ms` for a backend terminal event, then force-cancels and synthesizes `turn.interrupted` with reason `approval_timeout_exceeded` if needed. `IApprovalProvider.awaitDecision()` handles turn-cancellation `AbortSignal` by atomically resolving deny with reason `turn_cancelled`, journaling `permission.resolved`, returning `{ type: "aborted" }`, and making later user decisions idempotent no-ops.
- [ ] Implement approval audit trail.
  - **Acceptance criteria**: `permission.required` and `permission.resolved` events are journaled for allow, deny, timeout, and cancellation paths; Phase 3 tests verify audit event completeness even before the Phase 4 debug endpoint exposes them.
- [ ] Implement the Responses cancel endpoint route.
  - **Acceptance criteria**: `POST /openai/v1/responses/:id/cancel` requires auth, resolves external response ID to turn ID, calls `ISessionManager.cancelTurn()`, and returns appropriate success/error responses for authenticated cancel, missing response ID, already-terminal turn, and concurrent cancel.
- [ ] Implement cancellation paths.
  - **Acceptance criteria**: Response cancel endpoint, SSE disconnect, backend timeout, and shutdown cancellation are idempotent, terminal-state safe, and clean up process-backed sessions. SSE disconnect waits `disconnect_grace_ms` before transitioning the turn to `cancelling`, and cancellation proceeds only if the client does not reconnect within the grace period. If force-cancel exceeds `cancel_timeout_ms`, mark the turn `interrupted` with reason `force_cancel_timeout_exceeded` and mark the backend session abandoned.

### Phase 4: Event Journal and Minimal Debugging

- [ ] Implement canonical event journal and replay.
  - **Acceptance criteria**: Replay yields canonical events in sequence order, detects sequence gaps, and distinguishes incomplete non-terminal turns from corruption.
- [ ] Add redaction boundary and fail-closed behavior.
  - **Acceptance criteria**: Redacted raw/canonical/encoded forms obey the design's redaction rules; redaction failures raise `RedactionFailedError` and do not persist unredacted payloads.
- [ ] Add the minimal debug endpoint and golden replay tests.
  - **Acceptance criteria**: A single authenticated, read-only `GET /debug/turns/:id/events` endpoint exposes only redacted turn-event details required by `design.md`; golden tests cover backend events to canonical events to encoded OpenAI SSE output. Do not add broader observability, UI, thread debug routes, backend-session debug routes, or approval debug routes in this phase.

### Phase 5A: Recovery and Cleanup Hardening

- [ ] Implement startup recovery and backend process safety.
  - **Acceptance criteria**: Recovery completes before the HTTP server binds, validates process identity metadata before signaling PIDs, marks orphaned turns interrupted, and marks stale sessions non-reusable.
- [ ] Implement shutdown orchestration and forced disposal.
  - **Acceptance criteria**: Shutdown stops accepting requests, cancels in-progress turns with `cancel_timeout_ms`, force-disposes unresponsive backend sessions through graceful cancel, SIGTERM, and SIGKILL when supported, marks remaining non-terminal turns interrupted, flushes the event journal, marks abandoned sessions, and exits non-zero if the hard deadline is exceeded.
- [ ] Add cleanup, retention, and schema compatibility checks.
  - **Acceptance criteria**: Session pruning, event retention tombstone semantics, and schema compatibility checks are covered. Event retention is disabled by default; if enabled, it deletes only whole terminal-turn journals and never creates replay sequence gaps.

### Phase 5B: Configuration and Packaging Hardening

- [ ] Add config validation.
  - **Acceptance criteria**: Invalid auth, CORS wildcard, unsafe workspace, timeout, and retention configurations are rejected before HTTP bind.
- [ ] Add health checks, minimal metrics, and packaging.
  - **Acceptance criteria**: Health reports recovering/ready states, minimal metrics exist, and Bun packaging works when needed.

## Touch Surface

- **Likely new implementation paths**:
  - `src/core/types.ts`
  - `src/core/agent-events.ts`
  - `src/core/session-manager.ts`
  - `src/core/northbound-adapter.ts`
  - `src/core/agent-backend.ts`
  - `src/core/errors.ts`
  - `src/northbound/openai-responses/adapter.ts`
  - `src/northbound/openai-responses/schemas.ts`
  - `src/northbound/openai-responses/sse.ts`
  - `src/backends/copilot-cli/backend.ts`
  - `src/state/store.ts`
  - `src/state/sqlite-store.ts`
  - `src/state/migrations/`
  - `src/approvals/provider.ts`
  - `src/approvals/policy-provider.ts`
  - `src/server/app.ts`
  - `src/server/routes.models.ts`
  - `src/server/routes.responses.ts`
  - `src/server/routes.debug.ts` (minimal `GET /debug/turns/:id/events` only)
  - `src/server/routes.approvals.ts` (only if design Open Question #7 resolves HTTP approval UI into MVP scope)
  - `src/approvals/http-provider.ts` (only if design Open Question #7 resolves HTTP approval UI into MVP scope)
  - `src/cli/main.ts`
  - `scripts/probe-copilot-cli.ts`
- **Likely test paths**:
  - `src/**/*.test.ts`
  - `tests/fixtures/`
  - `tests/golden/`
- **Planning/docs paths**:
  - `plans/copilot-acp-responses-bridge/design.md`
  - `plans/copilot-acp-responses-bridge/plan.md`
  - `plans/copilot-acp-responses-bridge/todo.md`
  - `plans/copilot-acp-responses-bridge/lessons.md` only if implementation reveals a reusable correction.
- **Public API impacts**: Local OpenAI Responses-compatible HTTP endpoints under `/openai/v1`.
- **Schema impacts**: SQLite schema and migrations for workspace/thread/turn/client ref/backend session/event/approval persistence.
- **Configuration impacts**: Host/port, bearer token source, CORS mode/origin allowlist, workspace root/allowlist, permission mode, approval timeout, cancel timeout, retention settings.

## Verification Plan

### Target verification level

- [ ] L1 for pure type/interface and unit-test slices.
- [x] L2 for the overall MVP because it changes auth, state, process lifecycle, cancellation, and protocol behavior.
- [ ] L3 only when a real Codex + Copilot integration environment is available.

### Evidence to produce

- [ ] `bun test` for unit and contract coverage.
- [ ] Targeted route tests for `GET /openai/v1/models`, `POST /openai/v1/responses`, response retrieval, cancel, approval routes if introduced by Open Question #7, and the minimal debug route as it is introduced.
- [ ] Migration tests for SQLite schema creation and compatibility.
- [ ] Stored response retrieval tests for terminal and non-terminal `GET /responses/:id`.
- [ ] Golden replay tests for canonical event and OpenAI SSE output.
- [ ] Feature-gated integration proof for real backend startup, one-turn response, multi-turn continuation, cancellation, permission behavior, and restart recovery.
- [ ] Manual or scripted before/after proof that unauthenticated requests are rejected and authenticated local requests work.

## Rollback / Recovery

- **Rollback plan**: Keep each phase in reviewable commits. If a phase fails, revert that phase's commits without reverting prior stable phases.
- **Data safety notes**: Migration work must be additive or include explicit rollback notes before use with real workspaces. Do not delete non-terminal turns. Do not persist unredacted payloads.
- **Feature flags/config toggles**: Gate real backend integration and integration tests behind explicit configuration. Keep `MockBackend` available for deterministic tests.
- **Recovery flow**: If Phase 0 disproves a backend assumption, update `design.md` and this plan before implementing later phases. If implementation exposes a reusable process/design mistake, add `lessons.md`.

## Risks / Non-goals

- **Risks**:
  - Copilot backend lifecycle or approval semantics may not support the exact desired bridge behavior.
  - Responses streaming details may require adapter changes once tested against real Codex clients.
  - Process cleanup and PID identity validation are platform-sensitive.
  - Event journaling/redaction can become too heavy if Phase 4 tries to capture too much too early.
- **Explicit non-goals**:
  - No broad multi-protocol gateway in MVP.
  - No Chat Completions adapter in MVP.
  - No Anthropic/Gemini adapters in MVP.
  - No remote/multi-user deployment in MVP.
  - No private or reverse-engineered Copilot API usage.
  - No bridge-owned local tool broker in MVP.

## Review Notes / Annotations

- Gate 1 design review has completed with no remaining critical/important comments.
- Gate 2 is pending: implementation should not start until this plan and `todo.md` are approved.
- Phase 0 findings may require updating this plan before Phase 1 starts.

## Approval

- [ ] Plan approved by:
- Date:
