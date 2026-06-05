# Configuration

Volare reads runtime settings from environment variables and CLI flags. Keep secrets in the environment, not command-line arguments.

## Required auth

Every endpoint requires bearer auth.

```bash
bunx @lachimere/volare setup
```

The setup command generates or reuses `VOLARE_API_KEY`, saves it in `~/.volare/env`, configures Codex in the current profile-file layout, and updates the macOS GUI environment for Codex Desktop. Restart Codex Desktop after setup so it can read the saved token. You can still provide `VOLARE_API_KEY` directly in the environment; setup will reuse and persist that value. If setup generates a new token while the daemon is already running, restart the daemon before reconnecting clients.

If `VOLARE_API_KEY` is not set and no persisted token exists, the server generates an ephemeral token and prints it once to stderr. Daemon startup warns in this mode. This is useful for manual experiments but not for Codex CLI/Desktop, because clients need a stable token through `env_key = "VOLARE_API_KEY"`.

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
| `VOLARE_COPILOT_RUNTIME_MODE` | `process` | Copilot backend runtime: `process` keeps the existing per-turn `copilot --prompt` subprocess path; `acp` opts into the experimental long-lived `copilot --acp` runtime. |
| `VOLARE_COPILOT_ACP_MAX_WORKERS` | `10` | Maximum live ACP workers when ACP mode is enabled. The effective cap is no greater than `VOLARE_MAX_ACTIVE_SESSIONS`. |
| `VOLARE_COPILOT_PERMISSION_MODE` | `full` | Copilot CLI permission mode: `full` passes Copilot CLI `--allow-all`, `web` allows public URL fetches only, and `restricted` passes no non-interactive grants. |
| `VOLARE_COPILOT_MCP_MODE` | `disabled` | Copilot builtin MCP capability mode: `disabled` passes `--disable-builtin-mcps`; `unmediated` omits that flag and is valid only with permission mode `web` or `full`. |
| `SSL_CERT_FILE` | unset | Optional CA bundle path inherited by Copilot backend child processes and Python-backed tools. |
| `REQUESTS_CA_BUNDLE` | unset | Optional Requests-compatible CA bundle path inherited by child processes. |
| `CURL_CA_BUNDLE` | unset | Optional curl-compatible CA bundle path inherited by child processes. |

Persisted setup values are loaded first, process environment variables override persisted values, and CLI flags override both. Daemon mode passes CLI flags to the child process as environment overrides.

When these CA bundle variables are saved in `~/.volare/env`, Volare preserves them when setup rewrites the API key and passes them to Copilot backend child processes. This is useful for python.org Framework Python installs whose OpenSSL cert path does not point at a valid CA bundle.

By default, Volare invokes Copilot CLI with `--disable-builtin-mcps`. `VOLARE_COPILOT_PERMISSION_MODE` controls the non-interactive permission flags Volare passes to Copilot CLI; it does not make Volare a source-retrieval system or a mediator for Copilot-internal MCP tools. `VOLARE_COPILOT_MCP_MODE=unmediated` is explicit local-developer risk acceptance: Copilot internal MCP actions are not evaluated by Volare approvals or persisted as bridge-owned tool events.

`VOLARE_COPILOT_RUNTIME_MODE=acp` is opt-in and experimental. It keeps Volare's HTTP/API surface unchanged, but runs turns through long-lived Copilot CLI ACP workers instead of starting one `copilot --prompt` process per turn. Keep `process` mode for the stable rollback path. ACP mode rejects `VOLARE_COPILOT_MCP_MODE=unmediated`; use `VOLARE_COPILOT_RUNTIME_MODE=process` if you intentionally need unmediated Copilot MCP passthrough.

ACP mode relies on the local Copilot CLI authentication state. If Copilot CLI reports that authentication is required during ACP session setup, Volare calls ACP `authenticate` once with the advertised auth method and retries session creation once. Volare never executes terminal-auth commands embedded in ACP metadata and does not store Copilot credentials; if authentication still fails, run `copilot login` locally and retry.

## CLI flags

Package usage:

```bash
bunx @lachimere/volare setup
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
| `--copilot-mcp-mode <mode>` | `VOLARE_COPILOT_MCP_MODE` |
| `-d`, `--daemon` | Starts a background daemon. |

Common Codex setup/config flags:

| Command | Flag | Notes |
|---|---|---|
| `setup`, `config codex` | `--config`, `--config-path <path>` | Override the Codex config path. |
| `setup`, `config codex` | `--base-url <url>` | Override the Volare OpenAI Responses base URL. |
| `setup`, `config codex` | `--reasoning-effort <low|medium|high|xhigh>` | Set the Codex default reasoning effort. Defaults to `high`. |
| `setup` | `--codex-profile-mode <profile-file|legacy-single-file>` | Override the Codex config profile mode. Defaults to installed Codex detection, with `profile-file` as the safe fallback. |
| `config codex` | `--env-key <name>` | Override the environment variable Codex uses for the Volare API token. Defaults to `VOLARE_API_KEY`. |
| `config codex` | `--profile-mode <profile-file|legacy-single-file>` | Override the Codex config profile mode. Defaults to installed Codex detection, with `profile-file` as the safe fallback. |

Codex config hygiene commands:

```bash
bunx @lachimere/volare config codex doctor
bunx @lachimere/volare config codex repair
```

`doctor` reports safe issue codes and non-secret messages when Volare-owned Codex config has drifted. `repair` is an explicit alias for `config codex`; in modern profile-file mode it updates the base config plus `volare.config.toml`, cleans known Volare-owned legacy sections, removes obsolete `[profiles.volare]` state, and stores backups under `backups/volare/` next to the selected Codex config file.

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
