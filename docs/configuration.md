# Configuration

Agent Loom reads runtime settings from environment variables and CLI flags. Keep secrets in the environment, not command-line arguments.

## Required auth

Every endpoint requires bearer auth.

```bash
export AGENT_LOOM_API_KEY="replace-with-at-least-16-characters"
```

If `AGENT_LOOM_API_KEY` is not set, the server generates an ephemeral token and prints it once to stderr. This is useful for manual experiments but not for Codex CLI/Desktop, because clients need a stable token through `env_key = "AGENT_LOOM_API_KEY"`.

## Runtime environment

| Variable | Default | Notes |
|---|---|---|
| `AGENT_LOOM_API_KEY` | generated | Must be at least 16 non-whitespace characters when provided. |
| `AGENT_LOOM_HOST` | `127.0.0.1` | Local bind host. |
| `AGENT_LOOM_PORT` | `8000` | Valid range: `1..65535`. |
| `AGENT_LOOM_STATE_DB_PATH` | `.agent-loom/state.sqlite` | Daemon mode defaults to `~/.agent-loom/state.sqlite` unless already set. |
| `AGENT_LOOM_WORKSPACE_ROOT` | unset | Default explicit workspace root when configured. |
| `AGENT_LOOM_PROJECTLESS_WORKSPACE_ROOT` | `${TMPDIR:-/tmp}/al-projectless-workspace` | Used when requests do not send `metadata.workspace_root`. |
| `AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS` | unset | Colon-separated concrete roots allowed for explicit workspace requests. |
| `AGENT_LOOM_CORS_MODE` | `disabled` | Only disabled mode is supported. |
| `AGENT_LOOM_CORS_ALLOWED_ORIGINS` | unset | Wildcard origins are rejected. |
| `AGENT_LOOM_APPROVAL_TIMEOUT_MS` | `60000` | Approval wait timeout. |
| `AGENT_LOOM_CANCEL_TIMEOUT_MS` | `10000` | Backend cancellation timeout. |
| `AGENT_LOOM_DISCONNECT_GRACE_MS` | `5000` | Grace period before cancelling on client disconnect. |
| `AGENT_LOOM_HTTP_IDLE_TIMEOUT_SECONDS` | `0` | `0` disables Bun HTTP idle timeout for long streams. |
| `AGENT_LOOM_LOG_LEVEL` | `info` | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |
| `AGENT_LOOM_MAX_ACTIVE_SESSIONS` | `10` | Reserved for session limiting. |
| `AGENT_LOOM_EVENT_RETENTION_DAYS` | unset | When set, terminal-turn events older than the configured days can be pruned. |
| `AGENT_LOOM_COPILOT_PERMISSION_MODE` | `web` | Copilot CLI permission mode: `restricted` passes no non-interactive grants, `web` allows public URL fetches, and `full` passes Copilot CLI `--allow-all`. |

## CLI flags

Local source usage:

```bash
bun run src/cli.ts start --host 127.0.0.1 --port 8000
```

Common `start` flags:

| Flag | Environment override |
|---|---|
| `--host <host>` | `AGENT_LOOM_HOST` |
| `--port <port>` | `AGENT_LOOM_PORT` |
| `--state-db <path>` | `AGENT_LOOM_STATE_DB_PATH` |
| `--workspace-root <path>` | `AGENT_LOOM_WORKSPACE_ROOT` |
| `--projectless-workspace-root <path>` | `AGENT_LOOM_PROJECTLESS_WORKSPACE_ROOT` |
| `--log-level <level>` | `AGENT_LOOM_LOG_LEVEL` |
| `-d`, `--daemon` | Starts a background daemon. |

## Daemon paths

Daemon mode writes stable files under `~/.agent-loom` by default:

```text
~/.agent-loom/agent-loom.pid
~/.agent-loom/logs/agent-loom.log
~/.agent-loom/state.sqlite
```

Set `AGENT_LOOM_HOME` to move those daemon files. If `AGENT_LOOM_STATE_DB_PATH` is already set, daemon mode preserves it instead of overriding it.

## Workspace behavior

Use projectless mode for ordinary chats and broad questions. It prevents Agent Loom's repository from leaking into unrelated Codex/Desktop conversations.

Use explicit workspace metadata only when a client needs the backend to operate on a specific project:

```json
{
  "metadata": {
    "workspace_root": "/path/to/project"
  }
}
```

When `AGENT_LOOM_ALLOWED_WORKSPACE_ROOTS` is configured, explicit roots must be inside one of those roots.
