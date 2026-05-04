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

## Health and metrics

```bash
curl -H "Authorization: Bearer $VOLARE_API_KEY" \
  http://127.0.0.1:8000/healthz

curl -H "Authorization: Bearer $VOLARE_API_KEY" \
  http://127.0.0.1:8000/metrics
```

`/healthz` returns `ready` or `recovering`. `/metrics` currently returns readiness, uptime, and request count.

## Logs

Runtime logs are structured JSON lines. Important event names include:

| Event | Meaning |
|---|---|
| `runtime.starting`, `runtime.listening` | Server startup. |
| `runtime.api_key.generated` | Server generated an ephemeral token. |
| `http.request.completed` | Request completed with status and duration. |
| `workspace.resolved`, `workspace.selected` | Workspace selection and projectless status. |
| `turn.started`, `turn.stream.started`, `turn.stream.terminal` | Session manager turn lifecycle. |
| `backend.turn.started`, `backend.turn.completed`, `backend.turn.failed` | Copilot CLI backend lifecycle. |
| `responses.stream.started`, `responses.stream.completed`, `responses.stream.cancelled`, `responses.stream.failed`, `responses.stream.interrupted` | SSE lifecycle. Stream start logs include safe model and reasoning-effort metadata when the client sends it. |
| `journal.redaction_failed` | Redaction failed before event persistence. |

Logs can contain old non-JSON lines from earlier crashes or stack traces. Use line-by-line JSON parsing when analyzing mixed logs.

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

### Context appears to mention an unexpected Codex/Desktop path

Volare may still be in projectless mode. Check logs for `projectless: true` and inspect the persisted workspace root. Codex/Desktop can include its own UI or temporary workspace context in request text; Volare labels this as client-provided context in backend prompts.

### Context usage shows approximate values

Usage is estimated from prompt/output text because Copilot CLI does not currently expose authoritative token counts through this bridge. The wire fields remain standard OpenAI Responses usage fields.

## Shutdown and recovery

On shutdown, Volare stops accepting requests, runs state recovery cleanup, and force-stops the server even if recovery fails. On startup, non-terminal turns are marked interrupted and non-terminal backend sessions are abandoned so state is not left in an ambiguous active state.
