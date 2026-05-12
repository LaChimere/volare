# Codex latency observability design

## Feature summary

Add structured, redacted latency metrics to the Codex/OpenAI Responses streaming path so Volare can distinguish server setup time, session/state overhead, Copilot CLI backend latency, SSE streaming behavior, and client disconnects.

Main constraints:

- Keep protocol-neutral phases in `src/core/`, `src/backends/`, `src/events/`, and `src/logging/`.
- Keep OpenAI/Codex-specific metadata such as `model` and `reasoningEffort` at the server/adapter edge where those request fields already exist. Treat them as client-requested values, not proof of actual Copilot CLI backend model selection.
- Do not log prompts, request bodies, tool payloads, shell commands, stderr contents, tokens, prompt hashes, prompt prefixes/suffixes, or per-message length arrays.
- Prefer JSON log metrics first. Do not add a metrics backend or expand `/metrics` until logs prove an actual need.
- Keep instrumentation cheap: no per-delta log spam, no unbounded arrays, and no high-cardinality aggregate keys.

This split avoids a standalone "metrics framework" PR. The first PR lands immediately useful server/SSE metrics and extracts only tiny helpers if implementation duplication appears.

## Metric event catalog

Prefer extending existing lifecycle events with summary fields over adding a log line for every phase. Field names should use:

- `*Ms` for durations.
- `*Count` for counts.
- `*Bucket` for coarse bucketized values.
- `*Class`, `*Reason`, or `*Phase` for low-cardinality classifications.

Avoid bare names such as `latency`, `time`, or `size`.

### Server/SSE fields

PR 1 should extend existing server/SSE events:

| Event | Fields |
|---|---|
| `http.request.completed` for `POST /responses` | `bodyParseMs`, `workspaceHintMs`, `workspaceResolveMs`, `adapterParseMs`, `sessionStartMs`; existing `durationMs` means request received to SSE `Response` creation |
| `responses.stream.completed` | `responseOutcome`, `streamStartGapMs`, `firstAssistantSseFrameMs` when available, `sseActiveMs`, `sseFrameCount` |
| `responses.stream.failed` | `streamStartGapMs` when available, `firstAssistantSseFrameMs` when available, `sseActiveMs` when available, `sseFrameCount`, existing `errorCode` |
| `responses.stream.interrupted` | `interruptionReason`, `interruptionPhase`, `streamStartGapMs` when available, `firstAssistantSseFrameMs` when available, `sseFrameCount` |

For `POST /responses` only, `http.request.completed.durationMs` is response-ready latency, not the full streaming request lifetime; other routes keep their existing request-completion meaning. `streamStartGapMs` measures SSE `Response` construction to first stream pull/encoder execution so runtime/client first-pull delay is visible instead of being hidden inside assistant latency. `firstAssistantSseFrameMs` measures first stream pull/encoder execution to the first assistant content-bearing SSE frame, currently `response.output_text.delta`. It does not start at `new Response(stream)` construction, does not count `response.created` or `response.in_progress`, and does not claim true socket flush timing. When all three fields are present, request-received to first assistant SSE frame is `http.request.completed.durationMs + streamStartGapMs + firstAssistantSseFrameMs`; use the same monotonic clock and non-overlapping interval boundaries for all three fields, and preserve them separately so runtime/client first-pull delay is not mistaken for backend latency. Omit `firstAssistantSseFrameMs` when no assistant frame was emitted before terminal/interruption; do not encode absence as `0`.

Stream lifecycle metrics must combine encoded SSE/`ReadableStream` observations with canonical response outcome observations. `OpenAIResponsesAdapter.encodeStream()` emits `response.created` and `response.in_progress` before it pulls the first canonical event, and it returns after terminal SSE frames. PR 1 should define a small `StreamLifecycleContext` created by the server request handler and passed to the encoder/stream wrapper. The adapter should receive lifecycle observation through an explicit optional argument or local adapter/server-only context, such as callbacks for `onSseFrame`, `onFirstAssistantFrame`, and `onTerminalFrame`, invoked synchronously before yielding each relevant frame. The `ReadableStream` wrapper records cancellation before cleanup; a stream-wrapper finalizer logs one summary asynchronously after the stream iterator returns, throws, or is cancelled. Do not parse encoded SSE bytes in the server to infer lifecycle state. Keep these observer/context types local to `src/server/` and `src/northbound/openai-responses/`; do not add SSE-specific observer fields to protocol-neutral core types.

The lifecycle context must have explicit ordering semantics: encoder hooks synchronously update frame/outcome state before yielding the corresponding frame, cancellation records only a cancellation request timestamp/reason, and the final summary reads a snapshot after iterator completion/throw/return cleanup has settled. Avoid a design where the cancel handler directly classifies the final outcome while the encoder may still be advancing; classification should be centralized in one finalization function using the latest snapshot.

The finalizer must be idempotent. `ReadableStream.pull()` and `ReadableStream.cancel()` can interleave around `iterator.next()`/`iterator.return()`, so PR 1 should include a `finalized` guard (or equivalent single-assignment result) and define precedence: if terminal SSE frames were emitted and `[DONE]` was reached, classify as `responses.stream.completed`; if terminal SSE frames were emitted but a client cancel happens before `[DONE]`, classify as `responses.stream.interrupted` with `interruptionPhase: post_terminal` or treat it as benign completion if implementation can prove the terminal frame reached the client-facing queue; otherwise an explicit client cancellation before terminal wins as `responses.stream.interrupted` with `interruptionReason: client_disconnect`; thrown encoder/iterator errors classify as `responses.stream.failed`; a clean iterator return without terminal SSE frames also classifies as `responses.stream.failed` with a safe code such as `backend_ended_without_terminal`.

Separate transport outcome from agent response outcome:

- `responses.stream.completed` means the SSE stream reached `[DONE]` cleanly, even when the agent response outcome is `failed` or `incomplete`.
- `responseOutcome` on `responses.stream.completed` should be `succeeded`, `failed`, `incomplete`, or `unknown`, derived from terminal SSE/canonical events. Client/server stream interruption is represented by `responses.stream.interrupted` plus interruption fields, not by `responseOutcome`.
- `responses.stream.failed` is reserved for encoder/stream machinery errors and iterator completion without terminal SSE frames, not normal `response.failed` frames.
- `sseActiveMs` should measure first SSE frame to `[DONE]` or terminal stream error.
- The legacy `responses.stream.cancelled` event must be replaced by `responses.stream.interrupted` with `interruptionReason: client_disconnect` and an appropriate phase. Do not emit both for one disconnect; document the migration in `docs/operations.md`.

Use two fields for interruption classification:

- `interruptionReason`: `client_disconnect`, `server_aborted`, or `unknown`.
- `interruptionPhase`: `pre_first_sse_frame`, `pre_terminal`, `post_terminal`, or `unknown`.

`server_aborted` is reserved for Volare-initiated aborts such as shutdown or an internal request abort signal before terminal stream completion. Backend-originated failures should not be encoded as an interruption reason. A normal backend failure encoded as `response.failed` is a clean stream completion with `responseOutcome: failed`; an iterator/encoder failure is `responses.stream.failed`; backend end without terminal output should use the backend `failureClass` and the stream failure path rather than a separate `backend_failed` interruption.

`asyncIterableToStream.cancel()` or its replacement wrapper must set explicit shared state before cancellation cleanup so client disconnects can be distinguished from backend failures and clean encoder returns. The shared state should track at least `firstSseFrameEmitted`, `firstAssistantSseFrameEmitted`, and `terminalSseFrameEmitted`; post-terminal client closes should mean terminal SSE frames were emitted but `[DONE]` had not yet been reached, and should be classified as `post_terminal` or ignored as benign rather than treated as mid-stream backend failure.

### Core/backend fields

PR 2 should extend existing core/backend events:

Keep the three timing/counting layers separate: `sseFrameCount` and `firstAssistantSseFrameMs` belong to encoded SSE frames, `canonicalEventCount` belongs to canonical `AgentEvent`s, and `deltaCount`/`firstAssistantDeltaMs` belong to backend assistant-text deltas.

| Event | Fields |
|---|---|
| `turn.started` | `stateStartMs`, plus optional cheap subphase fields such as `threadResolveMs`, `backendSessionResolveMs`, and `turnPersistMs` |
| `turn.stream.started` / `turn.stream.terminal` where cheap | `activeTurnCount`, `canonicalEventCount` if they can be tracked without a queueing subsystem |
| `backend.turn.completed` | existing `durationMs` and `outputChars`, plus `promptAssembleMs`, `firstStdoutMs` when observable, `firstAssistantDeltaMs`, `deltaCount`, `maxObservedInterDeltaGapMs`, `promptSizeBucket`, `historyMessagesBucket` |
| `backend.turn.failed` | same fields when observable, plus `failureClass` |
| `journal.append.slow` or equivalent capped warning | `durationMs`, `outcome`; emit only above a threshold and at most once per turn |

`failureClass` should use observable classes such as `process_exit`, `stream_read_failure`, `cancelled`, and `backend_ended_without_terminal`.

`firstStdoutMs` belongs inside `BunCopilotPromptRunner`, where raw stdout is visible. If collecting it would require a broad runner API change, it should be deferred in favor of `firstAssistantDeltaMs`, and the deferral must be explicit in the PR.

Backend delta timings are observed through Volare's pull-based async generator path. Unless PR 2 deliberately adds runner-level timestamp capture that drains stdout independently, `firstAssistantDeltaMs` and `maxObservedInterDeltaGapMs` should be documented as observed pull-path timings that may include downstream backpressure, journal writes, SSE encoding, or client pull delays. Do not claim they are uncontaminated model-only timings.

`activeTurnCount` should be a lightweight in-process counter owned by `DurableSessionManager` if it is added at all. Do not introduce a queueing subsystem solely to support this metric; omit the field if it is not trivially derivable.

`promptSizeBucket` should be based on the assembled Copilot CLI prompt string produced by `formatCopilotPrompt()`, including serialized history and bridge context. It is a coarse correlation signal, not a content metric.

`sessionStartMs` on `http.request.completed` is the edge-observed duration of the server's call into session/turn startup. `stateStartMs` and optional subphase fields on `turn.started` are the manager-internal decomposition of that same broad window. Keep both only if they are clearly labeled this way; `sessionStartMs` should be interpreted as `stateStartMs` plus server-call/scheduling overhead, not as an additional independent phase.

For cancelled turns, cadence fields such as `maxObservedInterDeltaGapMs` should either be omitted/null or documented as non-comparable because cancellation and backpressure can dominate the observed gap.

A single client disconnect can produce both one stream-level `responses.stream.interrupted` and one backend-level `backend.turn.failed` with `failureClass: cancelled` if cancellation propagates into the runner. Treat those as correlated layer summaries for the same turn, not as two independent failures.

Buckets must be coarse. Suggested count buckets: `0`, `1-5`, `6-20`, `21-50`, `51+`. Suggested character buckets: `0`, `1-256`, `257-1024`, `1025-4096`, `4097-16384`, `16385+`.

## PR sequence

## PR 1: Instrument server/SSE lifecycle and disconnect reasons

Goal:

Measure the northbound request and SSE lifecycle so a slow turn can be classified as "slow before streaming starts" or "slow after streaming starts," and so `responses.stream.interrupted` becomes diagnosable instead of ambiguous.

Likely directories/files:

- `src/server/app.ts`
- `src/northbound/openai-responses/adapter.ts` only if parse timing or first encoded SSE timing is cleaner at the adapter boundary; otherwise measure adapter calls at the server call site
- `src/logging/` only for a tiny elapsed-time helper if needed
- `tests/unit_tests/server/app.test.ts`
- `tests/integration_tests/codex-cli-provider.test.ts`
- `docs/operations.md`

Dependencies:

- None.

Allowed changes:

- Add structured log events or fields for:
  - JSON body parse duration
  - workspace hint extraction and workspace resolution duration
  - adapter parse duration
  - session start duration
  - time until Volare returns the SSE `Response`
  - gap from SSE `Response` construction to first stream pull
  - time to first assistant content-bearing SSE frame
  - total stream duration
  - stream transport outcome and agent response outcome
- Use the event/field catalog above instead of adding one log event per phase.
- Add phase fields only to `http.request.completed` for `POST /responses`; do not add route-specific phase fields to health, metrics, models, or debug requests.
- Add the documented interruption reason and phase taxonomy from the catalog.
- Track whether the first SSE frame, first assistant SSE frame, and terminal SSE frame were emitted inside the stream wrapper so disconnects can be classified instead of collapsing to `unknown`.
- Fix the current stream lifecycle logging layer if needed so clean terminal SSE completion logs `responses.stream.completed` rather than `responses.stream.interrupted`.
- Replace legacy `responses.stream.cancelled` with classified `responses.stream.interrupted` to avoid double-counting client disconnects.
- Prefer `errorCode` and redacted safe error messages on stream failures; do not add raw error causes, CLI stderr, prompts, or request payloads to stream metric logs. If a touched existing failure log currently serializes `error: agentError` or another object that can include `cause`, replace it with safe fields for metric events.
- Keep safe correlation fields already present in this layer: `requestId`, `workspaceId`, `threadId`, `turnId`, `responseId`, plus edge-level `model` and `reasoningEffort` where the server already logs them.
- Document that `model` and `reasoningEffort` are client-requested metadata only; they can be used for correlation with perceived latency, but not as proof of the actual Copilot CLI backend model or effort.

Prohibited changes:

- No backend process instrumentation in this PR.
- No prompt/history/input/tool/stderr content logging.
- No new `/metrics` shape.
- No protocol-neutral core changes except a tiny timing helper if it is clearly reused.
- No attempt to claim true network flush timing; measure yielded/enqueued SSE frames only.

Acceptance criteria:

- A successful streaming request emits enough logs to compute:
  - request received to SSE `Response` creation
  - request received to first assistant content-bearing SSE frame when one exists, using `http.request.completed.durationMs + streamStartGapMs + firstAssistantSseFrameMs`
  - how much of that wait was runtime/client first-pull delay via `streamStartGapMs`
  - first SSE frame to terminal stream outcome
  - total stream duration
- Clean successful terminal streams log `responses.stream.completed`, not `responses.stream.interrupted`.
- Normal agent failures that are encoded as `response.failed` log `responses.stream.completed` with `responseOutcome: failed`, not `responses.stream.failed`.
- `responseOutcome: unknown` appears only when no terminal canonical/encoded response outcome was observed before stream finalization.
- Interrupted streams include a non-`unknown` reason in the common tested branches.
- Tests cover normal completion, encoded `response.failed`, stream machinery failure where feasible, client disconnect before terminal completion, and post-terminal disconnect behavior when observable. Prefer deterministic `ReadableStream` reader cancellation or abort-controller tests over real network-level disconnect tests.
- Existing auth, CORS, model catalog, and streaming response behavior are unchanged.

Validation commands:

- `bun run check`
- `bun run test`

Mergeability notes:

- This PR is useful by itself and should be small enough to review as the first production metric slice. It intentionally changes the operational meaning of `responses.stream.failed`/`interrupted` to distinguish transport failures from normal encoded agent failures; document the migration in `docs/operations.md`.

## PR 2: Instrument core and Copilot backend latency summaries

Goal:

Measure session/core/backend phases so a slow streamed turn can be classified as state overhead, prompt assembly, process startup, time-to-first-output, model/tool execution, or backend failure.

Likely directories/files:

- `src/core/durable-session-manager.ts`
- `src/backends/copilot-cli/backend.ts`
- `src/events/sqlite-event-journal.ts` only for a slow-append warning or summary if needed
- `tests/unit_tests/core/durable-session-manager.test.ts`
- `tests/unit_tests/backends/copilot-cli-backend.test.ts`
- `tests/unit_tests/events/sqlite-event-journal.test.ts` only if journal timing is touched
- `docs/operations.md`

Dependencies:

- PR 1 is preferred but not strictly required. If implemented in parallel, both PRs must use the same event naming conventions.

Allowed changes:

- Add structured summary metrics for:
  - thread/session/turn create or resume duration
  - active-turn count or queue/wait duration where observable
  - prompt assembly duration
  - Copilot CLI process runtime duration
  - spawn-to-first-raw-stdout duration
  - spawn-to-first-assistant-delta duration
  - delta count
  - max observed inter-delta gap
  - backend terminal outcome and failure class
  - optional journal slow-append warning, with duration and outcome only
- Use the event/field catalog above instead of adding one log event per phase.
- Add coarse prompt/history size buckets, for example `promptSizeBucket` and `historyMessagesBucket`; avoid exact values. Buckets should use the broad bands from the catalog.
- Track delta summaries with O(1) state only: last timestamp, running max gap, and count.
- Measure backend delta cadence as close to the runner/backend boundary as practical. If measurements remain on the pull path, name and document them as observed timings that may include downstream backpressure rather than pure backend/model latency.
- Emit at most one terminal summary log per backend turn, plus at most one capped slow-gap warning per turn if needed.

Prohibited changes:

- No per-delta info logs.
- No prompt text, prompt hashes, prompt slices, history content, per-message length arrays, attachment contents, tool input/output, shell command, or stderr content.
- No raw `error.cause`, CLI stderr, or serialized `VolareError` payloads in metric logs; use `errorCode`, `failureClass`, and safe redacted messages only. If instrumentation modifies existing failure logs that currently include serialized errors, sanitize those logs in the same PR rather than adding parallel unsafe metric fields.
- No Copilot CLI invocation, prompt, permission, or session-model changes.
- No persistent backend rewrite.

Acceptance criteria:

- Successful backend turns expose enough fields to compute:
  - active-turn or queue/wait context where observable
  - prompt assembly cost
  - backend runtime
  - first raw stdout latency when observable, or an explicit deferral if it would require a broad runner API change
  - first assistant delta latency
  - output cadence via delta count and max observed gap
  - prompt/history size bucket correlation
- Failed backend turns distinguish `process_exit`, `stream_read_failure`, `cancelled`, and `backend_ended_without_terminal` where currently observable.
- Tests verify metric fields for successful, failed, no-output, and cancellation paths.
- Added instrumentation has bounded memory and bounded log volume per turn.

Validation commands:

- `bun run check`
- `bun run test`

Mergeability notes:

- This PR can merge independently after PR 1 or in parallel with careful coordination. It should not introduce any user-visible behavior change.

## PR 3: Add a latency investigation playbook and final catalog

Goal:

Document how to use the new structured logs to identify likely root causes, finalize the operational metric catalog, and decide whether `/metrics` aggregates need a separate future PR.

Likely directories/files:

- `docs/operations.md`
- `docs/development.md` only if developer workflow notes are needed
- Optional `scripts/analyze-latency.ts` only if manual JSON-line commands become too brittle during implementation
- Tests only if an optional script is added

Dependencies:

- PR 1 and PR 2.

Allowed changes:

- Add a "Diagnosing slow Codex turns" playbook that explains:
  - how to start from `requestId` or `turnId`
  - how to compare server setup time, time-to-first-SSE, session/core time, backend runtime, first assistant delta, and max inter-delta gap
  - how to bucket common root causes
  - how to distinguish known fast backend failures from slow successful turns
  - how to interpret client disconnect reasons
  - how to correlate stream-level client disconnects with backend cancellation summaries without double-counting one turn as two independent failures
- Include safe copy-pasteable local commands or pseudocode that parse JSON logs without printing request content.
- If a helper script is added, keep it private/developer-oriented and avoid adding a stable `volare logs analyze` CLI surface in this slice.
- Include guidance for investigating `responseOutcome: unknown` if it appears repeatedly; it should be treated as an instrumentation gap unless explained by an older log format.
- Consolidate the final metric event catalog.
- Record concrete criteria for a later `/metrics` aggregate PR, for example:
  - a second consumer needs machine-readable aggregate metrics beyond ad-hoc log analysis, or
  - log-volume overhead becomes unacceptable in normal use, or
  - latency instrumentation emits more than a small bounded number of lines per turn at p99 despite the summary-only design, or
  - operational workflows need live readiness/latency status without reading log files.

Prohibited changes:

- No upload to third-party services.
- No automatic remediation.
- No raw prompt/body/stderr output.
- No new public CLI command unless explicitly approved after reviewing the playbook.
- No Prometheus/OpenTelemetry dependency.
- No `/metrics` aggregate implementation in this PR unless separately approved.

Acceptance criteria:

- A developer can classify a recent slow turn into one of these buckets:
  - server/request setup
  - workspace/session/state overhead
  - prompt assembly / large history
  - Copilot process startup
  - time-to-first-assistant-delta
  - long backend/model/tool execution
  - client disconnect/reconnect
  - known backend failure
- The playbook explains what remains unobservable without Copilot CLI upstream support.
- Documentation matches the metric event names implemented in PR 1 and PR 2.
- Logs remain the source of detailed per-turn diagnostics.
- Any future `/metrics` work is explicitly deferred or split into a new approved PR.

Validation commands:

- `bun run check`
- `bun run test` if scripts or code are added

Mergeability notes:

- This PR should wait until real metric names have landed. It is intentionally docs-first to avoid freezing a public analyzer before the signal shape is proven. If the catalog and `/metrics` decision are too large for the playbook PR during implementation, split them into a tiny follow-up doc-only PR, but keep that as an implementation-time judgment rather than a default fourth slice.

## Parallelization readiness

Must stay serial:

- PR 3 waits for PR 1 and PR 2.
- Final public docs and any `/metrics` follow-up decision wait for PR 3 and the final event names.

Can fan out:

- PR 1 and PR 2 can be implemented in parallel only if the same event naming convention is agreed first.
- If there is only one implementer, do PR 1 first because it produces immediate value and validates the naming approach.

Use `plan-parallel-work` before assigning explicit branch/worktree ownership to multiple agents.

## Risks

- Contract churn: metric names may need one refinement pass after real logs are inspected.
- Sensitive data: prompts, tools, commands, stderr, request bodies, and content-derived fingerprints must not leak.
- Cardinality: request/turn IDs are allowed for correlation but not for aggregate keys.
- Misclassification: client disconnects may still be partially `unknown` until Desktop behavior is observed.
- Performance overhead: excessive per-delta logging would worsen latency; only terminal summaries and capped warnings are allowed.
- Observability limits: true socket flush timing and internal Copilot CLI tool/model phases are not directly visible from Volare.
- Review hotspots: `src/server/app.ts`, `src/core/durable-session-manager.ts`, and `src/backends/copilot-cli/backend.ts` should be edited surgically.

## Rollback

- PR 1 can be reverted independently if server/SSE metric noise is too high.
- PR 2 can be reverted independently if backend/core instrumentation proves costly.
- PR 3 can be reverted without runtime behavior changes.
- Any future `/metrics` aggregate PR should remain separately revertible from structured runtime logs.
