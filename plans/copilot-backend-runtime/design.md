# Copilot backend runtime design

> Purpose: document the solution design for review and approval before execution planning.
> Do not proceed to plan/execution until this design is approved.

## Objective

- Problem: Volare is a long-lived daemon, but its Copilot backend currently pays per-turn CLI subprocess startup and loses any chance to reuse a stable backend inference channel.
- Goal: use Copilot CLI ACP server mode as the intended reusable Copilot runtime channel if protocol probes prove it can safely carry Volare turns, while preserving the current process-per-turn runner as the stable baseline and rollback path.
- Link to research: `plans/copilot-backend-runtime/research.md`

## Glossary

| Term | Meaning in this design |
|---|---|
| Volare daemon | The long-lived local HTTP service started by Volare. This already exists. |
| Backend session | Volare's durable per-thread backend session record, identified by `backendSessionId`. |
| ACP worker | A long-lived `copilot --acp` subprocess managed by Volare. |
| ACP protocol session | A session created inside an ACP worker via `session/new` and identified by the ACP `sessionId`. |
| Process mode | Current behavior: each turn invokes a fresh non-interactive `copilot --prompt ...` process. |
| ACP mode | Proposed behavior: Volare sends turns to one or more ACP workers over newline-delimited JSON-RPC. |
| Runtime mode | The Volare config choice between process mode and ACP mode. |

## Architecture / Approach

### High-level approach

Use ACP as the target runtime architecture, but keep it probe-gated and opt-in instead of doing a broad runtime rewrite:

1. Keep the existing `BunCopilotPromptRunner` as the default `process` mode.
2. Prove Copilot CLI ACP semantics with focused probes before writing production ACP runtime code.
3. If probes pass, add an `AcpCopilotPromptRunner` behind the existing `ICopilotPromptRunner` seam.
4. Preserve core runtime and OpenAI Responses wire contracts; the backend runner strategy is an implementation detail.
5. Add bounded diagnostics and tests around worker lifecycle, cancellation, and fallback/error behavior.

### Pre-plan probe gate

Design approval authorizes only the probe-gate execution plan. It does not authorize ACP runner implementation planning. After approval, run and record the probes below, update `research.md` and this design with the results, then create or update `plan.md`/`todo.md` for ACP runner implementation only if the gate passes. If any answer invalidates the assumptions below, revise this design and re-submit it for design approval instead of proceeding.

| Probe | Minimum answer needed before planning |
|---|---|
| ACP probe harness | Existing ACP probe code is corrected or replaced before any ACP result is trusted. Probes must use persistent stdin/stdout pipes, not a helper that writes once and immediately closes stdin. |
| ACP startup and handshake | `copilot --acp` starts, accepts newline-delimited JSON-RPC on stdio, returns a recognizable `initialize` response, and negotiates a supported integer `protocolVersion`. The probe must use `clientCapabilities`, not an LSP-style `capabilities` field, and must record `authMethods`. |
| Prompt request method | `session/new` and `session/prompt` work in the installed Copilot CLI, the prompt is sent as a `ContentBlock[]` with one text block, and assistant text arrives through the actual notification method emitted by Copilot CLI without driving an interactive TTY. |
| Turn completion framing | The ACP prompt turn completes by responding to the original `session/prompt` request with a `stopReason`, so Volare does not need process exit as the end-of-response boundary. |
| Cancellation | `session/cancel` works as a notification and the worker eventually drains the original `session/prompt` response with `stopReason: "cancelled"`; otherwise kill-and-replace must preserve current `cancel()` semantics. |
| Permission and auth callbacks | The probe determines whether Copilot CLI sends `session/request_permission` or requires `authenticate`. If either occurs, the first ACP design must include a minimal explicit handler before implementation planning. |
| Scope controls | cwd, permission mode, MCP mode, no-custom-instructions, and model behavior are understood at worker startup, `session/new`, or ACP config methods. If model is fixed at worker or session creation time, the implementation scope key must include model at that level. |
| Projectless cwd isolation | `session/new` honors the provided absolute cwd as a filesystem boundary, and one ACP worker handling sessions with distinct cwds does not leak filesystem scope or project context between them. |
| State isolation | ACP protocol sessions are independent per `sessionId`, resettable/closable, or safely bindable one-to-one to Volare `backendSessionId` values without cross-workspace or projectless leakage. |
| ROI measurement | Cold process startup/first-stdout cost is measured against p50/p90 backend duration. If the p50 process-start contribution is below 5% of p50 backend duration for representative turns, return to design and consider a different latency slug before building ACP runtime. |

Probe outcomes:

| Outcome | Action |
|---|---|
| All minimum answers pass and startup cost is material | Proceed to `plan.md`/`todo.md` for ACP runner implementation. |
| ACP transport, prompt, turn completion framing, required permission/auth handling, or state isolation fails | Do not implement ACP runtime in this slug; update design with the blocker and choose a different latency path. |
| Cancellation is unsupported or unreliable but prompt framing works | Plan ACP with kill-and-replace cancellation only if the behavior preserves existing cancel semantics and is explicitly tested. |
| ROI is below threshold | Do not build ACP as a latency-first optimization; prioritize concurrency/admission, prompt/history, or provider-latency work. |

### Key components / layers involved

| Layer | Role in this design |
|---|---|
| `src/backends/copilot-cli/` | Add ACP runner, frame parser, worker lifecycle, and tests if approved. Keep `BunCopilotPromptRunner` intact. |
| `src/runtime/server.ts` | Wire the selected runner strategy into `CopilotCliBackend`. |
| `src/server/config.ts` | Parse any new `VOLARE_COPILOT_*` runtime-mode config. |
| `src/core/durable-session-manager.ts` | Prefer no broad changes. It already owns durable session/turn lifecycle and calls backend `send/cancel/disposeSession`. |
| `src/northbound/openai-responses/` | No planned wire-shape changes for this slug. |
| `scripts/probe-copilot-cli.ts` | Extend or reuse for explicit ACP capability probes before enabling runtime mode. |

### Interaction / data flow

Baseline remains:

```text
OpenAI Responses request
  -> server auth / parse / workspace resolve
  -> DurableSessionManager startTurn/streamTurn
  -> CopilotCliBackend.formatCopilotPrompt()
  -> BunCopilotPromptRunner.run()
  -> fresh `copilot --prompt ...` process
  -> text deltas
  -> Responses SSE
```

Target ACP path, only after probes pass:

```text
Volare startup
  -> config selects process or acp runtime
  -> process mode: current runner
  -> acp mode: create ACP runner factory and initialize NDJSON JSON-RPC worker

First/session turn
  -> CopilotCliBackend.formatCopilotPrompt()
  -> AcpCopilotPromptRunner.run()
  -> ensure ACP worker and ACP protocol session exist for the backendSessionId
  -> send one session/prompt request with prompt [{ type: "text", text: promptText }]
  -> translate assistant text update notifications into text deltas
  -> treat the session/prompt response stopReason as the turn completion boundary
  -> yield text deltas through existing backend event path
```

The initial ACP runner should allow only one in-flight turn per worker unless the ACP protocol explicitly proves safe multiplexing. This avoids response interleaving and keeps cancellation semantics simple.

Expected reuse is conservative. The first ACP implementation should primarily reuse a protocol session for same-backend-session continuation turns, not promise broad cross-chat context reuse. If Copilot CLI proves independent ACP sessions inside one worker, the worker process can be shared across sessions while keeping one prompt in flight per worker; otherwise bind one worker to one Volare backend session. Projectless chats may get little or no reuse if clients produce distinct backend sessions or cwd scopes, and that is acceptable for the first implementation. If projectless workspace isolation or per-session state binding makes worker hit rate low, the implementation plan must report that and keep ACP experimental.

## Interface / API / Schema Design

### New or changed interfaces

Prefer no core interface change.

`ICopilotPromptRunner` is already enough for a first ACP implementation:

```ts
interface ICopilotPromptRunner {
  run(prompt: string, options: ICopilotPromptRunOptions): AsyncIterable<string>;
  cancel?(backendSessionId: string, options?: ICancelOptions): Promise<ICancelResult>;
  dispose?(backendSessionId: string): Promise<void>;
}
```

`ICopilotPromptRunOptions` already carries `backendSessionId` and canonical `cwd` to the runner. `permissionMode` and `mcpMode` are fixed on the runner instance. If ACP model selection must be set per turn, extend only the Copilot runner/backend option surface to pass `request.model`; do not change `IAgentBackend` unless a probe proves the current event model cannot represent ACP safely. If probes show model is fixed at worker startup or `session/new`, include model in the relevant worker/session scope key rather than sharing a mismatched worker.

If ACP cannot be represented as `prompt -> text deltas`, stop and update this design before changing `IAgentBackend` or core event types. Do not expand core abstractions speculatively.

Wire-shape constraints for the first ACP runner:

- serialize the existing `formatCopilotPrompt()` output as `[{ type: "text", text: promptText }]`
- record the actual method name Copilot CLI emits for turn updates and dispatch on that observed method
- inspect `authMethods` in `initialize`; if non-empty, implement the documented authenticate step before `session/new`
- implement a minimal permission-request handler if Copilot CLI emits `session/request_permission`; do not leave reverse requests unanswered. The handler must preserve the configured permission semantics: `allow` approves requests, `deny` denies requests, and any manual/interactively mediated permission mode that cannot be represented safely in first-version ACP fails the turn explicitly instead of approving by default.

### New runtime config

If implementation is approved, add a minimal runtime-mode selector:

| Variable | Values | Default | Notes |
|---|---|---|---|
| `VOLARE_COPILOT_RUNTIME_MODE` | `process`, `acp` | `process` | `process` keeps current behavior. `acp` is opt-in until proven stable. |
| `VOLARE_COPILOT_ACP_MAX_WORKERS` | integer | `10` | ACP-only cap for live worker processes. The initial implementation should also bound effective workers by `VOLARE_MAX_ACTIVE_SESSIONS` to avoid more workers than active Volare sessions. |

Implementation-level schema changes should be explicit:

- add `copilotRuntimeMode: 'process' | 'acp'` to `IServerRuntimeConfig`
- add `copilotAcpMaxWorkers: number` to `IServerRuntimeConfig` when ACP worker pooling is implemented
- add `VOLARE_COPILOT_RUNTIME_MODE: string | undefined` to `IServerRuntimeEnv`
- add `VOLARE_COPILOT_ACP_MAX_WORKERS: string | undefined` to `IServerRuntimeEnv` when ACP worker pooling is implemented
- parse with a narrow helper analogous to `parseCopilotPermissionMode`
- log the selected runtime mode in runtime startup diagnostics

Do not add `auto` initially. Silent fallback from ACP to process can hide correctness problems. If a user explicitly selects `acp` and the ACP startup/handshake fails, fail startup or fail the first turn with an explicit structured error. The stable fallback is to set the mode back to `process`.

### New or changed API endpoints

None.

### New or changed data models / schemas

None expected for the first approved implementation. Worker state should remain in memory. Do not persist ACP process IDs, protocol sessions, or model cache state until a concrete restart-recovery need exists.

### Contract compatibility notes

- OpenAI Responses request/stream shape stays unchanged.
- `IAgentBackend` stays protocol-neutral.
- `persistentSessions` should remain `false` until Volare can prove backend session continuity across Volare process restarts. In-process ACP worker reuse during one daemon lifetime is not the same as durable backend persistence.
- Existing projectless workspace isolation remains unchanged.
- Existing auth/CORS/bind defaults remain unchanged.

## Trade-off Analysis

### Option A (chosen): ACP runner, probe-gated and opt-in

- Summary: make ACP the intended backend runtime path; keep current per-turn process mode as default and add an ACP runner only after probes confirm initialization, prompt streaming, terminal framing, workspace/permission scoping, and cancellation behavior.
- Pros:
  - Uses a first-class Copilot CLI server mode instead of automating an interactive TTY.
  - Can remove per-turn CLI startup once a worker is initialized.
  - Fits the existing runner seam with minimal blast radius.
  - Keeps rollback simple: return to `process` mode.
  - Aligns with agent-maestro's long-lived-handle lesson without importing VS Code.
- Cons:
  - Requires protocol discovery and a frame parser.
  - May not reduce multi-minute model/tool latency if startup is a small fraction.
  - Conservative worker scoping may reduce reuse enough that ACP remains useful only for same-session continuations.
  - Cancellation may still require kill-and-replace if ACP has no cancel method.
- Why chosen: it is the only observed stable-looking path to true runtime reuse in Copilot CLI, and it can be gated without changing public API or core protocol types.

### Option B (rejected): pre-spawn pool of non-interactive `--prompt` processes

- Summary: try to reduce startup by keeping a pool of Copilot CLI processes ready for future prompts.
- Pros:
  - Conceptually simple if prompts could be sent after spawn.
  - Could reuse existing stdout parser if each process still exits after one prompt.
- Cons:
  - Current Volare runner passes `--prompt` at process startup with `stdin: 'ignore'`.
  - A process cannot be meaningfully pre-spawned without knowing the prompt unless another input protocol exists.
  - It does not solve response boundary or multi-turn reuse.
- Why rejected: it is not a real reusable channel for the observed CLI mode and risks adding pool complexity without latency benefit.

### Option C (rejected): copy agent-maestro's VS Code LM bridge

- Summary: host Volare inside VS Code or depend on `vscode.lm.*`.
- Pros:
  - Proven long-lived model client pattern in agent-maestro.
  - Direct model handle avoids CLI process startup.
- Cons:
  - Breaks Volare's standalone daemon architecture.
  - Couples runtime to VS Code extension host availability and lifecycle.
  - Conflicts with repository boundaries that keep core protocol-neutral and backend-specific integration under `src/backends/`.
- Why rejected: the architectural lesson is useful, but the dependency model is incompatible with Volare.

### Option D (rejected as first step): backend admission queue as primary fix

- Summary: limit concurrent Copilot turns to reduce upstream contention.
- Pros:
  - Could make local resource usage and upstream contention more predictable.
  - May help when multiple Codex/Desktop requests run simultaneously.
- Cons:
  - Does not remove per-turn startup.
  - Can make individual queued requests appear slower.
  - Needs product decisions around queue timeout, fairness, and user-visible backpressure.
- Why rejected as first step: useful later if metrics prove contention, but it is not the long-lived runtime channel the user asked to design.

## Key Design Decisions

### Decision 1: ACP before interactive-mode automation

- Context: Copilot CLI help exposes `--acp`, `--prompt`, `--interactive`, and session resume flags.
- Choice: Treat ACP as the first reusable-channel candidate.
- Rationale: ACP is a protocol/server mode. Interactive TTY automation is brittle, hard to test, and likely to violate structured streaming/cancellation expectations.

### Decision 2: default remains current process mode

- Context: Current process mode is simple, isolated, and already tested.
- Choice: `process` stays default; `acp` is explicit opt-in after implementation.
- Rationale: ACP semantics are not yet fully proven. Defaulting to a new long-lived worker could introduce state leakage, stuck workers, or cancellation regressions.

### Decision 3: keep first ACP implementation text-only

- Context: Current `CopilotCliBackend` emits text deltas and a terminal success/failure event; source/tool provenance work is intentionally separate.
- Choice: The first ACP runner should yield assistant text deltas through the existing path. Initialize ACP with minimal `clientCapabilities` and do not advertise terminal or filesystem callbacks. If Copilot CLI still sends permission requests, respond through an explicit minimal handler rather than blocking the turn. Do not add tool/progress/source mapping in this slug.
- Rationale: Text parity is the shortest safe path to validating runtime reuse. Tool provenance and source grounding require separate producers and contracts.

### Decision 4: worker scope is conservative

- Context: Workspace root, permission mode, MCP mode, and conversation/session state can leak if workers are shared too broadly.
- Choice: Start with one in-flight request per worker and conservative worker scoping. Because ACP `session/new` carries cwd, the preferred scope is one worker pool per permission mode and MCP mode, with ACP protocol sessions mapped one-to-one to Volare `backendSessionId` values. If model is fixed at worker or session creation, include model in the corresponding scope key. If Copilot CLI does not isolate ACP sessions reliably, bind each worker process to a single Volare backend session. Idle workers should be evicted after 5 minutes, but Volare durable sessions must outlive worker eviction; a later continuation can recreate an ACP worker/session and send the full formatted prompt history, preserving correctness while losing warm reuse. The initial ACP worker cap should use `VOLARE_COPILOT_ACP_MAX_WORKERS` with default `10`, and the effective cap should not exceed `VOLARE_MAX_ACTIVE_SESSIONS`. Cap exhaustion should fail explicitly rather than silently falling back to process mode.
- Rationale: Isolation is more important than maximizing reuse. Broader pooling can be added later only if ACP proves stateless or exposes explicit session reset.

### Decision 5: unmediated MCP is excluded initially

- Context: `VOLARE_COPILOT_MCP_MODE=unmediated` intentionally bypasses Volare approval mediation for Copilot internal MCPs.
- Choice: ACP mode should initially reject startup when MCP mode is `unmediated`; users who need unmediated MCP should keep `VOLARE_COPILOT_RUNTIME_MODE=process`.
- Rationale: Persistent unmediated tool state raises state-leak and permission-surprise risks. This is a stricter ACP-mode precondition, not a change to process mode behavior. Keep the first runtime optimization on the default safer path and document the matrix clearly in operations docs.

### Decision 6: cancellation is kill-and-replace unless ACP proves better

- Context: Current cancellation kills the turn-scoped process. A persistent worker cannot be killed without losing warm state.
- Choice: Prefer ACP `session/cancel` when probes confirm it behaves correctly. After sending it, keep draining updates until the original `session/prompt` response returns `stopReason: "cancelled"`. If the response does not arrive within the existing `VOLARE_CANCEL_TIMEOUT_MS` / `cancelTimeoutMs`, kill the worker that owns the in-flight request, remove it from service, and lazily create a replacement. Preserve current return semantics: if no turn is in flight for a backend session, `cancel()` returns `not_found` even if an idle worker exists. Multiple cancels for the same in-flight request must be idempotent and must not kill a replacement worker created after the first cancel.
- Rationale: It preserves the existing user-visible cancellation contract and avoids fake success if a worker cannot be interrupted.

### Decision 7: stalled-worker handling must be explicit

- Context: Process mode has a natural process-exit boundary; a persistent ACP worker can stay alive while a request is stuck.
- Choice: The implementation plan must define startup timeout, handshake timeout, idle eviction timeout, active-turn no-progress detection, and replacement backoff. No-progress detection should be based on ACP frame arrival, not raw wall-clock request duration alone. Any active-turn no-progress timeout must be conservative enough not to kill legitimate long-running model/tool work, and should emit structured diagnostics before replacing the worker. Auth/token expiry, network failure, and upstream provider errors must be treated as explicit worker lifecycle cases.
- Rationale: Long-lived workers need bounded failure behavior, but aggressive timeouts would regress valid long research turns.

### Decision 8: ACP protocol handling is a real peer implementation

- Context: ACP stdio is newline-delimited JSON-RPC and can include requests from the agent back to the client.
- Choice: The ACP runner must parse stdout as NDJSON JSON-RPC only, capture stderr as diagnostics only, negotiate and validate integer `protocolVersion`, and reject unsupported versions. It must respond explicitly to any unsupported client-callback request instead of ignoring it.
- Rationale: A persistent worker is unsafe if Volare treats ACP as plain text stdout. Protocol correctness is part of the runtime boundary.

### Decision 9: shutdown tears down ACP workers explicitly

- Context: Process mode has turn-scoped subprocesses; ACP mode introduces daemon-lifetime workers.
- Choice: Runtime shutdown must stop accepting new work, cancel or fail in-flight ACP turns with a structured terminal outcome, and kill remaining ACP workers. Startup recovery remains responsible for marking non-terminal turns interrupted after a crash.
- Rationale: Long-lived workers must not outlive the daemon or leave clients waiting on a stream that can never complete.

## Impact Assessment

- Affected modules/services:
  - `src/backends/copilot-cli/` for ACP runner, frame parsing, worker lifecycle, and tests.
  - `src/server/config.ts` for runtime-mode config if approved.
  - `src/runtime/server.ts` for runner selection.
  - `docs/configuration.md` and `docs/operations.md` for opt-in mode and troubleshooting.
- Public API/schema compatibility:
  - No northbound API change.
  - No OpenAI Responses schema change.
- Data migration needs:
  - None.
- Performance implications:
  - Best case: may remove repeated CLI process startup/bootstrap overhead after ACP worker initialization.
  - Worst case: no meaningful improvement if model/tool latency dominates; instrumentation must report this plainly.
  - First-turn latency only improves if an ACP worker is initialized before first request or if worker startup is much faster than process-per-turn startup.
- Security considerations:
  - Keep bearer auth required.
  - Keep CORS disabled.
  - Keep `127.0.0.1` default bind.
  - ACP mode must not introduce config that weakens auth, enables CORS, or changes bind defaults for development convenience.
  - Do not log prompts, ACP payload contents, auth tokens, or raw tool data.
  - Scope ACP protocol sessions by backend session and cwd; scope worker pools by permission/MCP mode unless probes prove a stricter worker boundary is required.
  - Do not enable ACP mode with unmediated MCP in the first implementation.
- Reliability considerations:
  - Worker unexpected exit should log a structured event and remove the worker from service.
  - Repeated worker startup failures should not loop indefinitely.
  - Idle workers should be evicted and globally bounded once worker reuse is implemented.
  - Worker presence must not change `cancel()` return semantics for sessions with no active turn.
  - Stalled startup/handshake and active-turn no-progress behavior must be explicitly tested.
  - Explicit `acp` mode should fail clearly when ACP is unsupported instead of silently degrading.
  - Process mode must remain intact as the known-good rollback path.

### Observability requirements

Because this is performance work, future implementation must add structured low-cardinality diagnostics before claiming improvement:

- ACP worker startup and handshake duration
- ACP session creation duration
- first ACP frame and first assistant text delta duration
- prompt duration and turn `stopReason`
- cancellation path (`session_cancel`, `kill_replace`, timeout)
- worker replacement reason
- active worker count and cap-exhausted count
- selected runtime mode

Names can follow existing log-event conventions during implementation, but they must be documented and covered by tests for presence where practical.

### Acceptance criteria for future ACP implementation plan/todo

Before ACP runner implementation execution, the implementation `plan.md` and `todo.md` must include outcome-level acceptance criteria. The current probe-gate plan/todo should instead gather evidence for these criteria and carry them forward into the implementation gate:

- process mode remains default and behavior-compatible with current tests
- ACP mode is unavailable unless pre-plan probes pass and are recorded
- ACP initialization uses NDJSON JSON-RPC with `clientCapabilities` and validates protocol version
- ACP probe harness fixes/replaces the current one-shot initialize probe before recording gate evidence
- ACP handles `authMethods` and permission requests explicitly when Copilot CLI emits them
- ACP prompt requests serialize text as a `ContentBlock[]` and tests cover frame construction
- ACP worker/session scope includes model if probes show model binding occurs at worker or session creation
- ACP prompt streaming maps only text deltas and stop reasons in the first implementation
- ACP worker/session scoping preserves projectless workspace isolation
- cancellation preserves existing `cancel()` return semantics and handles repeated cancel calls safely
- idle eviction, worker caps, cap exhaustion, startup/handshake timeout, active-turn no-progress, replacement backoff, auth/network/provider failure, shutdown, and unexpected exits are tested
- worker cap behavior uses `VOLARE_COPILOT_ACP_MAX_WORKERS` and does not confuse worker count with durable session count
- ACP mode rejects unmediated MCP until explicitly designed otherwise, and docs explain the incompatibility plus rollback to process mode
- performance claims include a before/after method and numbers

## Testing and Verification Strategy

Future implementation should include:

- Unit tests:
  - runtime mode config parsing and invalid values
  - ACP NDJSON frame encode/decode and rejection of malformed stdout
  - ACP worker initialize success/failure
  - protocol version negotiation and unsupported-version rejection
  - initialize responses with non-empty `authMethods`
  - `session/new`, `session/prompt`, actual update notification method, and stop-reason parsing against fake frames
  - outbound prompt frame construction with `ContentBlock[]`
  - text delta and stop-reason parsing using fake frames
  - permission requests are answered explicitly; unsupported reverse client requests are surfaced explicitly
  - worker unexpected exit handling
  - cancellation via `session/cancel`, drain-to-cancelled behavior, kill-and-replace timeout, and repeated-cancel idempotency
  - process mode remains unchanged
- Integration tests:
  - fake ACP server process that streams deterministic text
  - fake ACP server cancellation/stuck-worker scenarios
  - fake ACP server multi-session or non-isolated-session scenarios, depending on probe results
  - server `/responses` path still streams normal OpenAI Responses SSE through ACP runner
  - explicit fallback/rollback to process mode by config
- Manual/local probes:
  - fix or replace the ACP portions of `scripts/probe-copilot-cli.ts` before trusting probe output
  - measure process mode vs ACP mode startup, first stdout/frame, first assistant delta, total duration
  - test a long prompt and a client disconnect

Minimum verification level for code changes: L2. Because this is performance-related, include numbers and method before claiming improvement.

## Open Questions

- What exact ACP methods does Copilot CLI 1.0.49 support beyond `initialize`?
- Does the installed Copilot CLI implementation expose `session/new`, `session/prompt`, `session/update`, `session/cancel`, and optional close/resume behavior exactly as documented?
- Which update notification method name does Copilot CLI actually emit for streaming turn updates?
- Does `initialize` return auth methods, and does Copilot CLI require an authenticate call before `session/new`?
- Does Copilot CLI emit permission requests despite non-interactive permission flags?
- Can Copilot CLI ACP set permission mode, MCP mode, model, and no-custom-instructions at worker startup, session setup, or config-option time?
- Does Copilot CLI isolate independent ACP sessions in one worker process, or must Volare bind one worker to one backend session?
- Does Copilot CLI emit any reverse client callback methods when Volare advertises minimal `clientCapabilities`?
- Is first-turn latency meaningfully improved by eager worker initialization, or is the observed delay dominated by model/tool latency?
- Should backend concurrency limiting be a separate slug after ACP/process timings are measured?

## Review Notes / Annotations

This design intentionally stops before ACP runtime implementation. The current `plan.md` and `todo.md` are probe-gate artifacts only: they may cover probe harness work, fake-ACP tests, real Copilot CLI probes, evidence capture, and gate decisions. Only if the probe gate passes should the slug create or update implementation planning with atomic ACP runner slices.

2026-06-03 ACP discovery update: Copilot CLI 1.0.59 successfully handled `initialize`, `session/new`, and `session/prompt` over NDJSON JSON-RPC with minimal client capabilities. The observed update method was `session/update`, the terminal `session/prompt` response carried `stopReason: "end_turn"`, and `session/new` returned config options for `model` and `allow_all`. The probe also observed a redacted `copilot-login` terminal-auth method. This validates the basic prompt path but does not complete the cancellation, isolation, multiplexing, failure-mode, or ROI gates.

2026-06-03 behavior/ROI update: after correcting process-mode first-text measurement to parse assistant content instead of first stdout bytes, ACP met both first-text and terminal-completion thresholds on synthetic samples (`~5140ms` / `~9.52%` first-text savings and `~6927ms` / `~12.83%` terminal savings against historical backend p50). Native `session/cancel` did not return `stopReason: "cancelled"` in the behavior probe, so the first ACP runner must use kill-and-replace cancellation unless a later stronger probe proves native cancellation. A sibling-worker kill probe completed the sibling prompt after killing a separate worker, but stale-cancel/replacement races must still be covered by implementation tests. The temporary-home failure probe showed `session/new` can return a non-object/null result, so the implementation must validate response shape and fail explicitly on malformed ACP lifecycle responses.

Gate decision: proceed to ACP implementation planning, not direct implementation, under the outcome-table row "Cancellation is unsupported or unreliable but prompt framing and isolation pass." Required implementation-plan constraints: keep `process` default, keep ACP opt-in, use one in-flight prompt per worker, implement kill-and-replace cancellation with stale-cancel/replacement-race tests, validate returned `protocolVersion` and `session/new.sessionId`, handle malformed/null lifecycle responses explicitly, reject or handle auth-required states explicitly, reject unmediated MCP in ACP mode, cover stop-reading-stdout recovery via `session/cancel`, cover broad filesystem/permission-state isolation with fake or integration tests, cover network/token-expiry failure surfaces, and re-measure first-text plus terminal-completion ROI with the integrated runner before claiming improvement.

## Approval

- [x] Design approved by: User
- Date: 2026-05-20
