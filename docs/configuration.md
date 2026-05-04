# Configuration

Volare reads runtime settings from environment variables and CLI flags. Keep secrets in the environment, not command-line arguments.

## Required auth

Every endpoint requires bearer auth.

```bash
export VOLARE_API_KEY="replace-with-at-least-16-characters"
```

If `VOLARE_API_KEY` is not set, the server generates an ephemeral token and prints it once to stderr. Daemon startup warns in this mode. This is useful for manual experiments but not for Codex CLI/Desktop, because clients need a stable token through `env_key = "VOLARE_API_KEY"`.

## Runtime environment

| Variable | Default | Notes |
|---|---|---|
| `VOLARE_API_KEY` | generated | Must be at least 16 non-whitespace characters when provided. |
| `VOLARE_HOME` | `~/.volare` | Daemon-only root for the PID file, log file, and default daemon state database. |
| `VOLARE_HOST` | `127.0.0.1` | Local bind host. |
| `VOLARE_PORT` | `8000` | Valid range: `1..65535`. |
| `VOLARE_STATE_DB_PATH` | `.volare/state.sqlite` | Daemon mode defaults to `~/.volare/state.sqlite` unless already set. |
| `VOLARE_WORKSPACE_ROOT` | unset | Default explicit workspace root when configured. |
| `VOLARE_PROJECTLESS_WORKSPACE_ROOT` | `${TMPDIR:-/tmp}/volare-projectless-workspace` | Used when requests do not provide an explicit or Codex-derived workspace root. |
| `VOLARE_ALLOWED_WORKSPACE_ROOTS` | unset | Colon-separated concrete roots allowed for explicit workspace requests. |
| `VOLARE_CORS_MODE` | `disabled` | Only disabled mode is supported. |
| `VOLARE_CORS_ALLOWED_ORIGINS` | unset | Wildcard origins are rejected. |
| `VOLARE_APPROVAL_TIMEOUT_MS` | `60000` | Approval wait timeout. |
| `VOLARE_CANCEL_TIMEOUT_MS` | `10000` | Backend cancellation timeout. |
| `VOLARE_DISCONNECT_GRACE_MS` | `5000` | Grace period before cancelling on client disconnect. |
| `VOLARE_HTTP_IDLE_TIMEOUT_SECONDS` | `0` | `0` disables Bun HTTP idle timeout for long streams. |
| `VOLARE_LOG_LEVEL` | `info` | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |
| `VOLARE_MAX_ACTIVE_SESSIONS` | `10` | Reserved for session limiting. |
| `VOLARE_EVENT_RETENTION_DAYS` | unset | When set, terminal-turn events older than the configured days can be pruned. |
| `VOLARE_COPILOT_PERMISSION_MODE` | `full` | Copilot CLI permission mode: `full` passes Copilot CLI `--allow-all`, `web` allows public URL fetches only, and `restricted` passes no non-interactive grants. |

## CLI flags

Package usage:

```bash
bunx @lachimere/volare start --host 127.0.0.1 --port 8000
```

Common `start` flags:

| Flag | Environment override |
|---|---|
| `--host <host>` | `VOLARE_HOST` |
| `--port <port>` | `VOLARE_PORT` |
| `--state-db <path>` | `VOLARE_STATE_DB_PATH` |
| `--workspace-root <path>` | `VOLARE_WORKSPACE_ROOT` |
| `--projectless-workspace-root <path>` | `VOLARE_PROJECTLESS_WORKSPACE_ROOT` |
| `--log-level <level>` | `VOLARE_LOG_LEVEL` |
| `--copilot-permission-mode <mode>` | `VOLARE_COPILOT_PERMISSION_MODE` |
| `-d`, `--daemon` | Starts a background daemon. |

## Daemon paths

Daemon mode writes stable files under `~/.volare` by default:

```text
~/.volare/volare.pid
~/.volare/logs/volare.log
~/.volare/state.sqlite
```

Set `VOLARE_HOME` to move those daemon files. If `VOLARE_STATE_DB_PATH` is already set, daemon mode preserves it instead of overriding it.

## Workspace behavior

Use projectless mode for ordinary chats and broad questions. It prevents Volare's repository from leaking into unrelated Codex/Desktop conversations.

Use explicit workspace metadata when a client needs the backend to operate on a specific project:

```json
{
  "metadata": {
    "workspace_root": "/path/to/project"
  }
}
```

For Codex CLI requests, Volare also recognizes the Codex `x-codex-turn-metadata` workspace map and structured startup context as workspace hints when explicit metadata is absent. This keeps the backend working directory aligned with the project context Codex sends.

When `VOLARE_ALLOWED_WORKSPACE_ROOTS` is configured, explicit roots must be inside one of those roots.
