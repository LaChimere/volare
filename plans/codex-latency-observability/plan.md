# Codex latency observability implementation plan

## Objective

Implement the finalized log-first latency observability design so Volare can diagnose slow Codex/OpenAI Responses turns without adding a metrics backend, exposing prompt content, or changing runtime behavior.

The implementation follows `design.md` and preserves the boundaries captured in `research.md`: OpenAI/Codex-specific streaming details stay at the server/adapter edge, core/backend metrics stay protocol-neutral, and logs remain structured, bounded, and redacted.

## Scope

In scope:

- Server/request and SSE stream lifecycle metrics for `POST /responses`.
- Core/session/backend summary metrics that separate state, prompt assembly, process runtime, first-output, and delta cadence where observable.
- Operational documentation and a slow-turn investigation playbook based on the implemented log fields.

Out of scope:

- Prometheus/OpenTelemetry or another metrics stack.
- Expanding `/metrics` beyond its current readiness/uptime/request-count role unless explicitly approved later.
- Public `volare logs analyze` or other stable analyzer command.
- Copilot CLI invocation, prompt semantics, permission behavior, backend session model, or package version/release changes.
- Logging prompts, request bodies, tool payloads, shell commands, stderr contents, hashes, slices, or per-message length arrays.

## Execution sequence

### Slice 1: Server/SSE lifecycle metrics

Add the northbound request and encoded SSE stream instrumentation from PR 1 in `design.md`.

Key requirements:

- Add `bodyParseMs`, `workspaceHintMs`, `workspaceResolveMs`, `adapterParseMs`, and `sessionStartMs` to `http.request.completed` for `POST /responses` only.
- Preserve the `POST /responses`-only meaning of `http.request.completed.durationMs`: request received to SSE `Response` creation. Do not change other route timing semantics.
- Add a local stream lifecycle context/observer between `src/server/app.ts` and `src/northbound/openai-responses/adapter.ts`.
- Track event-specific stream fields:
  - `responses.stream.completed`: `responseOutcome`, `streamStartGapMs`, `firstAssistantSseFrameMs` when available, `sseActiveMs`, and `sseFrameCount`.
  - `responses.stream.failed`: `streamStartGapMs` when available, `firstAssistantSseFrameMs` when available, `sseActiveMs` when available, `sseFrameCount`, and safe `errorCode`.
  - `responses.stream.interrupted`: `interruptionReason`, `interruptionPhase`, `streamStartGapMs` when available, `firstAssistantSseFrameMs` when available, and `sseFrameCount`.
- Use `responseOutcome` only on cleanly completed streams, with values `succeeded`, `failed`, `incomplete`, or `unknown`.
- Measure `sseActiveMs` as first SSE frame to `[DONE]` or terminal stream error; do not use it as full request lifetime.
- Omit `firstAssistantSseFrameMs` when no assistant content-bearing SSE frame was observed; do not encode absence as `0`.
- Replace legacy `responses.stream.cancelled` with classified `responses.stream.interrupted`.
- Use the interruption taxonomy from `design.md`: `interruptionReason` is `client_disconnect`, `server_aborted`, or `unknown`; `interruptionPhase` is `pre_first_sse_frame`, `pre_terminal`, `post_terminal`, or `unknown`. Reserve `server_aborted` for Volare-initiated aborts such as shutdown or an internal request abort signal.
- Ensure encoded `response.failed` is logged as clean stream completion with `responseOutcome: failed`.
- Implement the idempotent finalizer precedence from `design.md`: terminal plus `[DONE]` is completed; terminal plus client cancel before `[DONE]` is `post_terminal` interrupted or benign if provably queued; pre-terminal client cancel is `client_disconnect` interrupted; thrown iterator/encoder errors are failed; clean iterator return without terminal is failed with a safe `backend_ended_without_terminal` code.
- Keep stream classification centralized in the finalizer: cancellation handlers only record cancellation state before cleanup and must not emit or classify final lifecycle events directly.
- Treat `responseOutcome: unknown` as an instrumentation gap that appears only when no terminal canonical or encoded response outcome was observed before stream finalization.
- Sanitize touched failure logs so metric logs use safe fields such as `errorCode` instead of serialized errors that may include causes.

Validation:

- Unit tests for normal completion, encoded response failure, stream machinery failure where feasible, client disconnect before terminal completion, and post-terminal disconnect behavior when observable.
- Tests should verify the timing fields use one monotonic clock with non-overlapping intervals where deterministic fakes make that practical.
- Update integration tests if existing provider coverage asserts legacy stream lifecycle names or cancellation behavior.
- `bun run check`
- `bun run test`

### Slice 2: Core/backend latency summaries

Add protocol-neutral state/backend summary metrics from PR 2 in `design.md`.

Key requirements:

- Add manager-side timing fields such as `stateStartMs` and cheap subphase fields where they can be measured without changing runtime behavior.
- Add backend summary fields such as `promptAssembleMs`, `firstStdoutMs` when observable, `firstAssistantDeltaMs`, `deltaCount`, `maxObservedInterDeltaGapMs`, `promptSizeBucket`, and `historyMessagesBucket`.
- Keep `sseFrameCount`/`firstAssistantSseFrameMs`, `canonicalEventCount`, and `deltaCount`/`firstAssistantDeltaMs` as separate timing/counting layers.
- Treat `sessionStartMs` as the server edge observation of session/turn startup and `stateStartMs` as the manager-internal decomposition of that same broad window; do not add them as independent phases in analysis.
- Keep backend delta timing caveats explicit if measurements remain on the pull path.
- Omit unobserved timing fields such as `firstStdoutMs` and `firstAssistantDeltaMs`; do not encode absence as `0`.
- Explicitly defer `firstStdoutMs` if collecting it requires a broad runner API change.
- Add `activeTurnCount`/`canonicalEventCount` only if they are cheap to derive; do not add queueing infrastructure solely for metrics.
- Add `failureClass` values for observable backend failure categories.
- Treat stream-level client disconnects and backend `failureClass: cancelled` summaries as correlated layer summaries for one turn, not independent failures.
- For cancelled turns, omit cadence fields such as `maxObservedInterDeltaGapMs` or document them as non-comparable instead of treating them like successful-turn cadence.
- Track delta cadence with O(1) state only, such as last timestamp, running max gap, and count. Do not add per-delta info logs.
- Use the bucket bands from `design.md` for count and character buckets.
- Decide whether a capped journal slow warning is useful; implement it only if it can remain bounded at at most one warning per turn.

Validation:

- Unit tests for successful, failed, no-output, and cancellation paths.
- Journal timing tests only if journal instrumentation is touched.
- `bun run check`
- `bun run test`

### Slice 3: Operations playbook and final catalog

Document how to use the implemented logs to diagnose slow Codex turns.

Key requirements:

- Update `docs/operations.md` with the stable event/field catalog.
- Add a slow-turn diagnosis playbook that starts from `requestId` or `turnId`.
- Include safe copy-pasteable local log parsing examples or pseudocode that do not print request content.
- Explain how to classify server setup, workspace/session/state overhead, prompt/history size, process startup, first assistant delta, backend/model/tool execution, client disconnect/reconnect, and known backend failures.
- Explain how to correlate stream-level disconnects with backend cancellation summaries without double-counting one turn.
- Explain that repeated `responseOutcome: unknown` should be treated as an instrumentation gap unless explained by older log formats.
- Explicitly defer `/metrics` aggregates and public analyzer commands unless separately approved, and record the concrete revisit criteria from `design.md`: a second machine-readable aggregate consumer, unacceptable log-volume overhead, more than a small bounded number of lines per turn at p99, or a live readiness/latency workflow that cannot use log files.

Validation:

- `bun run check`
- `bun run test` if scripts or code are added

## Review and merge discipline

- Keep each slice atomic and independently reviewable.
- PR 1 should land first when a single implementer is doing the work because it validates event naming and immediately fixes ambiguous stream lifecycle logs.
- PR 2 may run in parallel with PR 1 only if event names remain aligned with `design.md`.
- PR 3 waits for real metric names from PR 1 and PR 2.
- Do not create commits until the relevant checks for the current slice pass and the user has allowed committing.
- If committing is approved later, keep plan/todo status updates tied to the same atomic slice they describe.

## Safety constraints

- Do not log prompts, request bodies, tool payloads, shell commands, stderr contents, tokens, prompt prefixes/suffixes, prompt hashes, prompt slices, attachment contents, per-message length arrays, raw `error.cause`, or serialized `VolareError` payloads.
- Use safe low-cardinality fields such as `errorCode`, `failureClass`, `interruptionReason`, and `interruptionPhase`.
- Keep `requestId`, `workspaceId`, `threadId`, `turnId`, and `responseId` as correlation fields, not aggregate keys.
- Keep `model` and `reasoningEffort` as client-requested correlation metadata only.

## Acceptance criteria

- Slow streamed turns can be separated into server setup, stream startup, session/core, backend, first assistant output, output cadence, and disconnect categories using structured logs.
- Clean terminal streams log `responses.stream.completed`; normal encoded agent failures use `responseOutcome: failed`; transport/encoder failures use `responses.stream.failed`; client disconnects use classified `responses.stream.interrupted`.
- Metrics logs remain bounded, low-cardinality, and redacted.
- Tests cover the new stream and backend lifecycle semantics.
- Operational docs explain the implemented fields and known observability limits.
