# Codex latency observability research

## Problem

Codex Desktop feels slow when sending messages through Volare, both while waiting for an assistant response and while the backend appears to be doing tool-like work. The current logs prove that turns can take tens of seconds to several minutes, but they do not yet explain where the time is spent.

## Current request path

The current architecture routes a Codex/OpenAI Responses request through:

1. `src/server/app.ts`: auth, JSON body parsing, workspace hint extraction, workspace resolution, request parsing, turn startup, SSE response creation.
2. `src/core/durable-session-manager.ts`: durable thread/session/turn creation, backend event consumption, canonical event recording, terminal status updates.
3. `src/backends/copilot-cli/backend.ts`: prompt framing, Copilot CLI process spawn, stdout JSON parsing, stderr collection, process exit handling.
4. `src/northbound/openai-responses/adapter.ts`: canonical event to Responses SSE encoding.
5. `src/events/sqlite-event-journal.ts`: canonical event persistence and redaction.

## Existing observability

Volare already emits structured lifecycle logs:

- `http.request.completed` in `src/server/app.ts` includes request status and `durationMs`.
- `responses.stream.started`, `responses.stream.completed`, `responses.stream.failed`, and `responses.stream.interrupted` wrap SSE iteration.
- `turn.started`, `turn.stream.started`, `turn.stream.terminal`, `turn.stream.failed`, and `turn.stream.interrupted` wrap session-manager lifecycle.
- `backend.turn.started`, `backend.turn.completed`, and `backend.turn.failed` wrap Copilot CLI backend lifecycle.
- `/metrics` currently returns only readiness, uptime, and total request count.

These are useful but too coarse for latency diagnosis. They do not capture first-byte/first-token timing, process spawn timing, time-to-first-backend-delta, per-delta gaps, prompt size, history size, tool/event phase timing, journal write overhead, SSE encode/write overhead, or client disconnect timing.

## Log evidence from recent local usage

A safe aggregation over recent `~/.volare/logs/volare.log` lines showed:

| Signal | Observation |
|---|---|
| `http.request.completed` | p50 `0ms`, p90 `11ms`, p99 `16ms`, max `75ms` |
| `backend.turn.completed` | p50 about `54s`, p90 about `134s`, max about `588s` |
| `turn.stream.terminal` | nearly identical to `backend.turn.completed` for successful turns |
| `responses.stream.interrupted` | p50 about `7.5s`, p90 about `106s`, max about `588s` |
| `backend.turn.failed` | p50 about `0.5s`, dominated by known Copilot CLI non-interactive failures |

Interpretation:

- HTTP request duration is not an end-to-end latency metric because it ends when Volare returns the SSE `Response`, not when the stream finishes.
- For successful turns, end-to-end stream duration is dominated by the Copilot CLI backend runtime.
- `responses.stream.interrupted` is currently ambiguous and may also be inflated by logging-layer placement: the Responses encoder returns after terminal SSE frames, which can close the inner canonical-event generator before `logAgentEventStream()` marks completion. PR 1 should fix or move stream lifecycle logging so successful encoded streams are not mislabeled as interrupted.
- Failed non-interactive Copilot CLI runs are fast and should be separated from slow successful turns.

## Likely root-cause classes to investigate

1. **Backend model latency**: model choice and reasoning effort (`gpt-5.5`, `high`/`xhigh`) can dominate response time.
2. **Prompt/history growth**: Volare serializes full conversation history into every Copilot CLI prompt, so older threads may pay increasing prompt ingestion cost.
3. **Prompt assembly cost**: current logs do not measure how long `formatCopilotPrompt()` and related history/attachment summarization take before process spawn.
4. **Process startup overhead**: each turn spawns a fresh Copilot CLI process; no persistent backend session is used by `CopilotCliBackend`.
5. **Time to first token**: current logs do not distinguish process spawn, first raw stdout, non-content status output, model queueing/thinking, and first assistant text delta.
6. **Tool-call opacity**: Volare does not yet have a bridge-owned tool-call broker; Copilot CLI internal tool activity is not surfaced as structured `tool.observed`/progress events.
7. **Journal/SSE overhead**: canonical events are redacted and written to SQLite before SSE encoding, but write timing is not measured.
8. **Client disconnect behavior**: Desktop may close/reconnect streams; Volare currently logs interruption but not enough context to classify whether the backend had already completed.
9. **Concurrency and queueing**: concurrent turns may contend on SQLite journal writes or backend process capacity, but Volare does not currently log active-turn counts or queue/wait phases.
10. **Copilot CLI version/regression issues**: known upstream non-interactive failures should be tracked separately from latency.

## Constraints

- Keep core runtime protocol-neutral. Metrics names may mention generic phases; OpenAI/Codex-specific wire details belong in the northbound adapter or server layer.
- Logs must stay structured and redacted. Do not log prompts, request bodies, authorization headers, tool inputs/outputs, or file contents.
- Local endpoints must remain bearer-authenticated and CORS-disabled by default.
- Prefer low-cardinality fields for metrics-like logs so they are easy to aggregate from JSON lines.
- Do not introduce a heavyweight metrics stack before the JSON log metrics are proven useful.
- Tests should travel with the implementation slice they validate.
- Prefer useful instrumentation over a standalone metrics framework. A tiny helper is acceptable only when it removes repetition in the first real instrumentation PR.
- Prompt/history size should be bucketed, not logged as exact content-derived fingerprints.

## Non-goals for this slice

- Do not change Copilot CLI invocation semantics, prompt content, permission behavior, or backend session model.
- Do not add Prometheus/OpenTelemetry or a public metrics surface before log metrics prove the need.
- Do not attempt to measure true socket flush time; the current `ReadableStream` wrapper can measure first yielded/enqueued SSE bytes, not kernel/network flush.
- Do not attempt to infer internal Copilot CLI tool activity unless it appears in stable, parseable CLI output.
- Distinguish three timing layers: canonical `AgentEvent`s, encoded SSE frames, and backend stdout/text deltas. They happen at different points and should not share one ambiguous `eventCount` or first-event metric.

## Unknowns

- Whether Codex Desktop has client-side reconnect behavior that inflates `responses.stream.interrupted`.
- Whether Copilot CLI can emit stable progress/tool events that Volare can parse safely.
- Whether the largest perceived delay is time-to-first-token or long gaps between deltas after the first token.
- Whether prompt/history size correlates strongly with slow turns in real usage.
- Whether process spawn time is meaningful compared with model latency.
- Whether concurrent requests or SQLite write contention materially affect real Desktop usage.
- Whether client-requested `model`/`reasoningEffort` match actual Copilot CLI backend execution. Current Volare logs can correlate latency with what Codex sent, but not prove which model Copilot CLI actually used unless Copilot CLI exposes that signal.

## Design implication

This should be split into small PRs, but not into a standalone metrics-framework PR. The first slice should add immediately useful server/SSE instrumentation, the second should add core/backend summaries, and later documentation/tooling should use real metric names to classify root causes.
