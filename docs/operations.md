# Operations

This guide covers local operation and debugging.

## Start and stop

Foreground:

```bash
export AGENT_LOOM_API_KEY="replace-with-at-least-16-characters"
bunx @lachimere/agent-loom start
```

Daemon:

```bash
bunx @lachimere/agent-loom start -d
bunx @lachimere/agent-loom status
bunx @lachimere/agent-loom stop
```

Daemon logs:

```bash
bunx @lachimere/agent-loom logs
tail -f ~/.agent-loom/logs/agent-loom.log
```

## Health and metrics

```bash
curl -H "Authorization: Bearer $AGENT_LOOM_API_KEY" \
  http://127.0.0.1:8000/healthz

curl -H "Authorization: Bearer $AGENT_LOOM_API_KEY" \
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
| `responses.stream.started`, `responses.stream.completed`, `responses.stream.cancelled`, `responses.stream.failed`, `responses.stream.interrupted` | SSE lifecycle. |
| `journal.redaction_failed` | Redaction failed before event persistence. |

Logs can contain old non-JSON lines from earlier crashes or stack traces. Use line-by-line JSON parsing when analyzing mixed logs.

## Debug journal

Fetch canonical/debug events for a turn:

```bash
curl -H "Authorization: Bearer $AGENT_LOOM_API_KEY" \
  http://127.0.0.1:8000/debug/turns/<turn-id>/events
```

The journal is useful when comparing backend events with encoded Responses SSE output. Redaction runs before persistence and records security markers when redaction fails.

## Common issues

### `401 Unauthorized`

The server and client are using different tokens. Start Agent Loom with the same `AGENT_LOOM_API_KEY` that Codex uses through `env_key = "AGENT_LOOM_API_KEY"`.

### `EADDRINUSE`

Port `8000` is already listening. Check daemon status:

```bash
bun run src/cli.ts status
```

Stop the existing daemon or start a new instance with `--port`.

### `bunx @lachimere/agent-loom` returns npm 404

The package must be published before `bunx @lachimere/agent-loom ...` can resolve it from npm. Use the local source entrypoint before publication:

```bash
bun run src/cli.ts help
```

### Context appears to mention an unexpected Codex/Desktop path

Agent Loom may still be in projectless mode. Check logs for `projectless: true` and inspect the persisted workspace root. Codex/Desktop can include its own UI or temporary workspace context in request text; Agent Loom labels this as client-provided context in backend prompts.

### Context usage shows approximate values

Usage is estimated from prompt/output text because Copilot CLI does not currently expose authoritative token counts through this bridge. The wire fields remain standard OpenAI Responses usage fields.

## Shutdown and recovery

On shutdown, Agent Loom stops accepting requests, runs state recovery cleanup, and force-stops the server even if recovery fails. On startup, non-terminal turns are marked interrupted and non-terminal backend sessions are abandoned so state is not left in an ambiguous active state.
