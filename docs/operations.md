# Operations

This guide covers local operation and debugging.

## Start and stop

Foreground:

```bash
bunx @lachimere/volare setup
bunx @lachimere/volare start
```

Daemon:

```bash
bunx @lachimere/volare start -d
bunx @lachimere/volare status
bunx @lachimere/volare stop
```

If `VOLARE_API_KEY` is not set and no persisted token exists in `~/.volare/env`, daemon startup warns that it will generate an ephemeral token in the logs. Run `bunx @lachimere/volare setup` before starting the daemon when Codex CLI/Desktop will connect.

Daemon logs:

```bash
bunx @lachimere/volare logs
tail -f ~/.volare/logs/volare.log
```

## Shutdown behavior

Shutdown first asks the HTTP server to stop accepting new requests, then drains runtime control-plane work. Pending ACP worker admissions are rejected with `service_unavailable`; tracked ACP workers are disposed by sending `SIGTERM` and then `SIGKILL` if they have not exited within the runner cleanup grace window. SQLite-backed turn state, approvals, and journal events are written synchronously by the local database; the current journal has no buffered writer to flush or close separately after terminal cleanup is recorded.

## Health and metrics

```bash
curl -H "Authorization: Bearer $VOLARE_API_KEY" \
  http://127.0.0.1:8000/healthz

curl -H "Authorization: Bearer $VOLARE_API_KEY" \
  http://127.0.0.1:8000/metrics
```

`/healthz` returns `ready` or `recovering`. `/metrics` returns readiness, uptime, request count, and aggregate live-turn grounding counters:

| Counter | Meaning |
|---|---|
| `turns_total` | Accepted live turns after auth, parse, workspace resolution, and turn creation. |
| `turns_with_zero_tools_total` | Terminal live turns with no observed bridge-level tool event. |
| `turns_with_sources_total` | Terminal live turns with backend-provided source refs. This remains `0` until a concrete source producer exists. |
| `turns_with_citation_like_output_total` | Terminal live turns whose assistant text contains markdown links, bare `http(s)` URLs, or `[n]` references. |
| `turns_with_grounding_warnings_total` | Terminal live turns with content-grounding warnings such as source-needed answers without observable sources. |
| `turns_unmediated_total` | Accepted live turns using explicit unmediated tooling mode. |
| `acp_workers_max` | Configured ACP worker ceiling when ACP runtime is active. |
| `acp_workers_active` | Live ACP workers currently tracked by the runner. |
| `acp_workers_creating` | ACP workers currently starting up. |
| `acp_workers_idle` | Live ACP workers without an active prompt. |
| `acp_workers_running_prompts` | Live ACP workers currently running a prompt. |
| `acp_admission_active` | Worker admission leases currently held. |
| `acp_admission_queue_depth` | ACP worker admissions waiting for a worker slot. |
| `acp_admission_granted_total` | Total ACP worker admissions granted since startup. |
| `acp_admission_queued_total` | Total ACP worker admissions queued since startup. |
| `acp_admission_timeout_total` | Total ACP worker admissions that timed out since startup. |
| `acp_admission_cancelled_total` | Total ACP worker admissions cancelled before a worker was admitted. |
| `acp_admission_shutdown_total` | Total ACP worker admissions rejected during shutdown drain. |

These counters are aggregate-only. They intentionally do not include prompt text, domains, warning-code breakdowns, source URLs, session IDs, hostnames, local paths, raw ACP frames, or token values. Auth failures, parse failures, rejected requests, `GET` handlers, debug reads, and journal replay do not increment live-turn counters.

`acp_workers_creating` includes worker creations that are waiting for admission as well as workers that are already starting a process. Use it with `acp_admission_queue_depth` to distinguish queued admissions from process startup work.

## Capacity errors

When the active-turn gate or ACP worker admission queue is saturated, OpenAI-compatible `POST /responses` requests fail with HTTP 429 and an OpenAI-style body:

```json
{
  "error": {
    "type": "rate_limit_error",
    "message": "...",
    "code": "capacity_exhausted",
    "param": null
  }
}
```

Use `Retry-After` for standard seconds-based retry behavior. `X-Volare-Retry-After-Ms` carries the same hint with millisecond precision, and `X-Volare-Capacity-Scope` distinguishes `active_turns` from `backend_worker_admission`. ACP admission timeouts use `code: "backend_worker_admission_timeout"` with the same retry headers.

During shutdown, queued ACP admissions fail as HTTP 503 with `{ "error": { "type": "service_unavailable", "message": "..." } }` plus the same retry headers when the error is observable before the stream starts.

## Approval resolution

When Volare creates a pending approval, resolve it through the Volare control plane rather than an OpenAI-compatible route:

```bash
curl -X POST -H "Authorization: Bearer $VOLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "turn_id": "turn_...",
    "bridge_session_id": "bridge_session_...",
    "decision": { "type": "allow", "scope": "once" }
  }' \
  http://127.0.0.1:8000/control/approvals/approval_.../resolve
```

The endpoint validates that the approval, turn, and bridge session belong together before recording the terminal decision. Repeating a resolve request for an already terminal approval returns the stored decision without mutating it. Control-plane errors use `{ "error": { "code": "...", "message": "..." } }` rather than OpenAI error shapes.

Successful responses include the resolved ownership tuple, terminal status, and stored decision, for example `{ "approval_id": "approval_...", "turn_id": "turn_...", "bridge_session_id": "bridge_session_...", "status": "resolved", "decision": { "type": "allow", "scope": "once" } }`.

## Logs

Runtime logs are structured JSON lines. Important event names include:

| Event | Meaning |
|---|---|
| `runtime.starting`, `runtime.listening` | Server startup. |
| `runtime.unmediated_mcp.enabled` | Startup warning when Copilot builtin MCPs are enabled without Volare approval mediation. |
| `runtime.api_key.generated` | Server generated an ephemeral token. |
| `http.request.completed` | Request completed with status and duration. For `POST /responses`, `durationMs` measures request receipt to SSE `Response` creation and includes phase fields such as `bodyParseMs`, `workspaceResolveMs`, `adapterParseMs`, and `sessionStartMs`; other routes keep normal request-completion semantics. |
| `workspace.resolved`, `workspace.selected` | Workspace selection and projectless status. |
| `turn.started`, `turn.audit`, `turn.stream.started`, `turn.stream.terminal`, `turn.stream.interrupted`, `turn.stream.failed` | Session manager turn lifecycle and per-accepted-turn capability audit. |
| `backend.turn.started`, `backend.turn.completed`, `backend.turn.failed` | Copilot CLI backend lifecycle and summary metrics. |
| `backend.acp.worker.created`, `backend.acp.worker.exited`, `backend.acp.worker.replaced`, `backend.acp.worker.reaped`, `backend.acp.prompt.completed` | ACP runtime worker and prompt lifecycle events when `VOLARE_COPILOT_RUNTIME_MODE=acp` is enabled. |
| `backend.acp.admission.queued`, `backend.acp.admission.granted`, `backend.acp.admission.timed_out`, `backend.acp.admission.cancelled`, `backend.acp.admission.shutdown_rejected` | ACP worker admission queue diagnostics. These include counts and backend session IDs only, never prompts, raw ACP payloads, workspace paths, or tokens. |
| `backend.acp.cancel.requested`, `backend.acp.cancel.native_sent`, `backend.acp.cancel.native_succeeded`, `backend.acp.cancel.fallback_kill`, `backend.acp.cancel.timed_out` | ACP cancellation strategy diagnostics. |
| `responses.stream.started`, `responses.stream.completed`, `responses.stream.failed`, `responses.stream.interrupted` | SSE lifecycle. Stream start logs include safe model and reasoning-effort metadata when the client sends it. |
| `responses.metadata.reserved_keys_stripped` | Client metadata attempted to use reserved `volare` / `volare.*` keys; logs key paths only, never values. |
| `journal.redaction_failed` | Redaction failed before event persistence. |

Logs can contain old non-JSON lines from earlier crashes or stack traces. Use line-by-line JSON parsing when analyzing mixed logs.

For streamed `POST /responses`, the SSE lifecycle summary distinguishes transport outcome from agent response outcome:

- `responses.stream.completed` means the stream reached `[DONE]`. Its `responseOutcome` is `succeeded`, `failed`, `incomplete`, or `unknown`; normal encoded `response.failed` frames are still completed streams with `responseOutcome: "failed"`.
- `responses.stream.interrupted` replaces the legacy `responses.stream.cancelled` event. Client disconnects use `interruptionReason: "client_disconnect"` and an `interruptionPhase` such as `pre_first_sse_frame`, `pre_terminal`, or `post_terminal`; do not count old `responses.stream.cancelled` and new interrupted events together. If cancellation cleanup itself fails, the stream remains interrupted and may include a safe `cleanupErrorCode`.
- `responses.stream.failed` is reserved for stream machinery failures, encoder/iterator errors, or an iterator ending without a terminal SSE frame. It logs a safe `errorCode`, not serialized error causes.

SSE timing fields are emitted only when observable. `streamStartGapMs` measures SSE `Response` construction to first stream pull, `firstAssistantSseFrameMs` measures first stream pull to the first assistant content-bearing SSE frame, and `sseActiveMs` measures first SSE frame to `[DONE]` or terminal stream error. If no assistant content frame is emitted before terminal or interruption, `firstAssistantSseFrameMs` is omitted rather than logged as `0`. `model` and `reasoningEffort` are client-requested correlation metadata only; they do not prove the actual Copilot CLI backend model or effort.

Core and backend summaries use separate counters:

- `turn.started` includes `stateStartMs` and cheap subphase fields such as `threadResolveMs`, `backendSessionResolveMs`, and `turnPersistMs`. On `POST /responses`, `http.request.completed.sessionStartMs` is the server-observed call into this startup path; do not add it to `stateStartMs` as an independent phase.
- `turn.audit` is emitted once per accepted live turn before backend execution starts. It includes server-owned correlation IDs and `copilotMcpMode`, `copilotPermissionMode`, and `unmediatedToolingEnabled`; it does not include prompt text, workspace paths, client metadata, source refs, or tool output. Journal replay and stored-response reads do not emit new `turn.audit` records.
- `turn.stream.started` includes `activeTurnCount`. Terminal, interrupted, and failed stream logs include `canonicalEventCount`, which counts canonical `AgentEvent` records and is separate from SSE `sseFrameCount`.
- `backend.turn.completed` and `backend.turn.failed` include `promptAssembleMs`, `deltaCount`, coarse `promptSizeBucket` and `historyMessagesBucket`, and assistant delta timing fields when observed. Successful completion logs also include grounding-adjacent fields such as `groundingDomain`, `needsSourceGrounding`, `groundingCitationLikeOutputCount`, `groundingEvaluatedByteCount`, `groundingTruncated`, and `groundingWarningCodes`. `durationMs` keeps the backend runner duration after prompt assembly; it does not include `promptAssembleMs`.
- `firstAssistantDeltaMs` and `maxObservedInterDeltaGapMs` are pull-path observations from backend text deltas. They can include downstream backpressure, journaling, SSE encoding, or client pull delays, so treat them as local correlation fields rather than model-only latency. Cancelled backend failures omit non-comparable `maxObservedInterDeltaGapMs` because cancellation and backpressure can dominate the observed gap.
- ACP runtime logs are present only when `VOLARE_COPILOT_RUNTIME_MODE=acp` is explicitly configured. Use `backend.acp.worker.created` to confirm worker startup, `backend.acp.prompt.completed` to inspect ACP `stopReason` and prompt duration, and `backend.acp.worker.replaced` / `backend.acp.worker.exited` / `backend.acp.worker.reaped` to diagnose kill-and-replace cancellation, worker crashes, or background idle cleanup. ACP cancel logs include the configured strategy, native wait budget, fallback reason, observed `stopReason`, and whether a worker was reused. Roll back by setting `VOLARE_COPILOT_RUNTIME_MODE=process` and restarting Volare.
- `backend.turn.failed.failureClass` uses low-cardinality classes such as `process_exit`, `stream_read_failure`, `cancelled`, `backend_ended_without_terminal`, and `unknown`. These logs use safe `errorCode`/`failureClass` fields and do not serialize raw causes, CLI stderr, prompts, or history.

`firstStdoutMs` is not emitted yet. Capturing it accurately belongs inside the raw stdout runner, while the current backend boundary only observes parsed assistant deltas; adding it would require a broader runner API change. `journal.append.slow` is also deferred for now: the journal has per-append timing but no bounded per-turn slow-append aggregator or threshold configuration, and adding state only for this warning would be more design than the current log-first slice needs.

## Diagnosing slow Codex turns

Start from a `requestId`, `turnId`, or `responseId` in the logs. Keep analysis local and only print low-cardinality fields; do not dump request bodies, prompts, history, tool payloads, stderr, or raw error causes.

To inspect one turn safely from JSON logs:

```bash
TURN_ID=resp_...
jq -c --arg turnId "$TURN_ID" '
  select(.turnId == $turnId or .responseId == $turnId) |
  {
    event,
    requestId,
    workspaceId,
    threadId,
    turnId,
    responseId,
    status,
    durationMs,
    bodyParseMs,
    workspaceHintMs,
    workspaceResolveMs,
    adapterParseMs,
    sessionStartMs,
    stateStartMs,
    threadResolveMs,
    backendSessionResolveMs,
    turnPersistMs,
    sessionId,
    copilotMcpMode,
    copilotPermissionMode,
    unmediatedToolingEnabled,
    activeTurnCount,
    canonicalEventCount,
    streamStartGapMs,
    firstAssistantSseFrameMs,
    sseActiveMs,
    sseFrameCount,
    responseOutcome,
    interruptionReason,
    interruptionPhase,
    promptAssembleMs,
    firstAssistantDeltaMs,
    maxObservedInterDeltaGapMs,
    deltaCount,
    promptSizeBucket,
    historyMessagesBucket,
    failureClass,
    errorCode,
    cleanupErrorCode
  }' ~/.volare/logs/volare.log
```

If you only have a `requestId`, first find the associated IDs without printing content:

```bash
REQUEST_ID=...
jq -c --arg requestId "$REQUEST_ID" '
  select(.requestId == $requestId) |
  {event, requestId, threadId, turnId, responseId, status, durationMs}
' ~/.volare/logs/volare.log
```

Use the summary fields to classify the likely bottleneck:

| Bucket | Signals |
|---|---|
| Server/request setup | High `http.request.completed.durationMs` before streaming, especially `bodyParseMs`, `workspaceHintMs`, `workspaceResolveMs`, or `adapterParseMs`. |
| Workspace/session/state overhead | High `sessionStartMs` and matching `turn.started.stateStartMs` or subphases such as `threadResolveMs`, `backendSessionResolveMs`, or `turnPersistMs`. Treat `sessionStartMs` as the server-observed wrapper around state startup, not an extra additive phase. |
| Runtime/client first-pull delay | High `streamStartGapMs`, which means the SSE `Response` was constructed but the stream was not pulled promptly. |
| First assistant SSE delay | High `firstAssistantSseFrameMs`, after accounting for request setup and `streamStartGapMs`. This is encoded SSE timing, not socket flush timing. |
| Prompt assembly or large history | High `promptAssembleMs`, `promptSizeBucket`, or `historyMessagesBucket`. Buckets are coarse correlation signals, not content metrics. |
| First backend delta delay | High `firstAssistantDeltaMs`. This is observed on the pull path and can include backpressure or downstream work. |
| Long backend/model/tool execution | High backend `durationMs`, high `sseActiveMs`, high `deltaCount`, or high `maxObservedInterDeltaGapMs` on non-cancelled turns. |
| Client disconnect/reconnect | `responses.stream.interrupted` with `interruptionReason: "client_disconnect"` and a phase such as `pre_terminal` or `post_terminal`. |
| Known backend failure | `backend.turn.failed.failureClass` such as `process_exit`, `stream_read_failure`, or `cancelled`, plus safe `errorCode`. |

For a successful streamed turn with all northbound timings present, approximate request receipt to first assistant SSE frame as:

```text
http.request.completed.durationMs + streamStartGapMs + firstAssistantSseFrameMs
```

Keep the layers separate: `sseFrameCount` counts encoded SSE frames, `canonicalEventCount` counts protocol-neutral `AgentEvent`s, and `deltaCount` counts backend assistant text deltas.

Normal encoded agent failures are not transport failures: a `response.failed` frame should produce `responses.stream.completed` with `responseOutcome: "failed"`. Repeated `responseOutcome: "unknown"` on current logs should be treated as an instrumentation gap unless the lines came from an older Volare version before stream outcomes were recorded.

A single client disconnect can produce both `responses.stream.interrupted` and a correlated `backend.turn.failed` with `failureClass: "cancelled"` for the same turn. Count that as one interrupted turn across two layers, not as two independent failures.

Some latency remains unobservable without upstream Copilot CLI support. In particular, `firstStdoutMs` is not available yet, and pull-path backend delta timings are not pure model timings.

Detailed per-turn diagnostics remain log-first. `/metrics` exposes only safe aggregate counters; latency aggregates and a public analyzer command are deferred until a separate follow-up is approved. Revisit that decision if a second consumer needs machine-readable aggregate latency data, log-volume overhead becomes unacceptable in normal use, instrumentation emits more than a small bounded number of lines per turn at p99, or operators need live readiness/latency status that cannot use local log files.

## Debug journal

Fetch canonical/debug events for a turn:

```bash
curl -H "Authorization: Bearer $VOLARE_API_KEY" \
  http://127.0.0.1:8000/debug/turns/<turn-id>/events
```

The journal is useful when comparing backend events with encoded Responses SSE output. Redaction runs before persistence and records security markers when redaction fails.

## Common issues

### `401 Unauthorized`

The server and client are using different tokens. Start Volare with the same `VOLARE_API_KEY` that Codex uses through `env_key = "VOLARE_API_KEY"`.

### Codex Desktop says `Missing environment variable: VOLARE_API_KEY`

Run setup and restart Codex Desktop:

```bash
bunx @lachimere/volare setup
```

On macOS, setup applies `VOLARE_API_KEY` to the current GUI environment and writes a user LaunchAgent so future Codex Desktop launches can read the same token. It also saves the token under `~/.volare/env` so Volare can start without a manual shell export.

If setup generated a new token while the daemon was already running, restart the daemon too:

```bash
bunx @lachimere/volare stop
bunx @lachimere/volare start -d
```

### `EADDRINUSE`

Port `8000` is already listening. Check daemon status:

```bash
bunx @lachimere/volare status
```

Stop the existing daemon or start a new instance with `--port`.

### `bunx @lachimere/volare` returns npm 404

`@lachimere/volare` is the published package name. Confirm the scoped package and version:

```bash
npm view @lachimere/volare version
bunx --bun @lachimere/volare help
```

If a release was just published, wait for npm registry propagation and retry. Also check that the command uses the scoped package name; unscoped `volare` is not this project.

### `bunx @lachimere/volare` keeps running an older version

Refresh Bun's package cache and verify the npm latest version:

```bash
bunx @lachimere/volare update
```

The command clears Bun's global install/bunx cache and resolves `@lachimere/volare@latest`, so unrelated cached `bunx` tools may be reinstalled later. If a release was published moments ago and the registry has not propagated yet, wait briefly and run the update command again.

### Codex config appears stale or inconsistent

Check the Volare-owned Codex provider/profile-file config without printing tokens or the full config:

```bash
bunx @lachimere/volare config codex doctor
```

If doctor reports drift, run `bunx @lachimere/volare config codex repair` to rewrite only Volare-owned Codex config. Modern repair preserves unrelated Codex settings while updating both `config.toml` and `volare.config.toml`, and writes backups under `backups/volare/` next to the selected Codex config file.

### Context appears to mention an unexpected Codex/Desktop path

Volare may still be in projectless mode. Check logs for `projectless: true` and inspect the persisted workspace root. Codex/Desktop can include its own UI or temporary workspace context in request text; Volare labels this as client-provided context in backend prompts.

### Context usage shows approximate values

Usage is estimated from prompt/output text because Copilot CLI does not currently expose authoritative token counts through this bridge. The wire fields remain standard OpenAI Responses usage fields.

### Python reports certificate chain verification failures

If agent output mentions `CERTIFICATE_VERIFY_FAILED`, `unable to get local issuer certificate`, or `本机 Python 的证书链校验失败`, check the local Python trust store:

```bash
bunx @lachimere/volare doctor certs
```

On macOS python.org Framework Python installs, the usual root cause is a missing OpenSSL CA bundle at Python's default `cert.pem` path. The safe repair is to install or update `certifi`, point Python's `cert.pem` at `certifi.where()`, and optionally persist the CA path for Volare-launched child processes:

```bash
python3 -m pip install --upgrade certifi
CERTIFI_PATH="$(python3 -c 'import certifi; print(certifi.where())')"
PYTHON_CERT_FILE="$(python3 -c 'import ssl; print(ssl.get_default_verify_paths().openssl_cafile)')"
mkdir -p "$(dirname "$PYTHON_CERT_FILE")"
ln -sf "$CERTIFI_PATH" "$PYTHON_CERT_FILE"

cat >> ~/.volare/env <<EOF
export SSL_CERT_FILE="$CERTIFI_PATH"
export REQUESTS_CA_BUNDLE="$CERTIFI_PATH"
export CURL_CA_BUNDLE="$CERTIFI_PATH"
EOF
```

Do not disable TLS verification with `PYTHONHTTPSVERIFY=0`, `verify=False`, or `--insecure`. `curl` may work while Python fails because curl and python.org Python can use different CA stores; treat curl fallback as a temporary workaround, not a fix.

### ACP mode fails to start or behaves unexpectedly

ACP mode is opt-in. First confirm the runtime mode in `runtime.starting`:

```bash
jq -c 'select(.event == "runtime.starting") | {copilotRuntimeMode, copilotAcpMaxWorkers, copilotMcpMode}' \
  ~/.volare/logs/volare.log
```

If `VOLARE_COPILOT_MCP_MODE=unmediated` is set, ACP mode is rejected by configuration. Use `VOLARE_COPILOT_RUNTIME_MODE=process` for immediate rollback, or keep MCP mode disabled when testing ACP. ACP worker failures should surface as structured `backend.acp.*` or `backend.turn.failed` events without raw prompts or ACP payload dumps.

ACP cancellation defaults to conservative kill-and-replace. To inspect native cancellation support without changing production behavior, run:

```bash
bun run scripts/probe-copilot-acp.ts --cancel
```

The probe classifies current Copilot CLI behavior as `native-reusable`, `native-terminal-only`, `unsupported`, or `unknown`. `VOLARE_COPILOT_ACP_CANCEL_STRATEGY=native` can be used for local validation, but native cancellation only succeeds when ACP returns `stopReason: "cancelled"` and a reuse verification prompt succeeds; otherwise Volare logs `backend.acp.cancel.fallback_kill` and keeps the safe kill-and-replace path. `VOLARE_COPILOT_ACP_CANCEL_STRATEGY=auto` behaves like `kill` unless the runner has in-memory `native-reusable` evidence.

If a stream fails with `Authentication required`, refresh the Copilot CLI login state and retry:

```bash
copilot login
```

Volare attempts ACP `authenticate` once and retries `session/new` once. It does not execute terminal-auth commands from ACP metadata, so persistent authentication failures require operator action rather than daemon-side credential handling.

### Answers contain citations but no sources in metrics

Prompt grounding rules are not provenance. Volare can ask the backend to avoid unsupported citations, but it only counts source evidence when a Volare-observable producer emits it. Backend Python, certificate, fetch, browser, or tool-output problems are backend/tool-content failures unless Volare itself fails transport, parsing, auth, journaling, or SSE encoding.

## Shutdown and recovery

On shutdown, Volare stops accepting requests, runs state recovery cleanup, and force-stops the server even if recovery fails. On startup, non-terminal turns are marked interrupted and non-terminal backend sessions are abandoned so state is not left in an ambiguous active state.
