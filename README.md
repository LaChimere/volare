# Agent Loom

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

Agent Loom starts a local OpenAI Responses-compatible bridge at `http://127.0.0.1:8000/openai/v1`. It requires bearer auth for every endpoint. Set `AGENT_LOOM_API_KEY` to a token with at least 16 non-whitespace characters, or the server will generate an ephemeral startup token and print it once to stderr.

Useful endpoints:

```text
GET  /healthz
GET  /metrics
GET  /openai/v1/models
POST /openai/v1/responses
GET  /openai/v1/responses/:id
POST /openai/v1/responses/:id/cancel
GET  /debug/turns/:id/events
```

Configuration defaults are local and restrictive: host `127.0.0.1`, port `8000`, CORS disabled, state database `.agent-loom/state.sqlite`, approval timeout `60000ms`, cancel timeout `10000ms`, disconnect grace `5000ms`, HTTP idle timeout disabled with `AGENT_LOOM_HTTP_IDLE_TIMEOUT_SECONDS=0`, log level `info`, projectless workspace root `${TMPDIR:-/tmp}/al-projectless-workspace`, and event retention disabled unless `AGENT_LOOM_EVENT_RETENTION_DAYS` is set. Requests that do not include `metadata.workspace_root` use the projectless workspace so normal Codex/Desktop chats do not inherit the Agent Loom repository context; explicit `metadata.workspace_root` requests still use the requested workspace after allowlist checks.

## Agent Loom CLI

The npm package exposes an `agent-loom` executable for Bun-native usage:

```bash
bunx agent-loom start
```

Useful commands:

```bash
agent-loom start                         # foreground server
agent-loom start -d                      # daemon server
agent-loom status                        # daemon status
agent-loom stop                          # stop the daemon
agent-loom logs                          # print the daemon log path
agent-loom config codex                  # configure Codex CLI/Desktop
```

`agent-loom start` accepts common runtime overrides such as `--host`, `--port`, `--state-db`, `--workspace-root`, `--projectless-workspace-root`, and `--log-level`. Keep `AGENT_LOOM_API_KEY` in the environment rather than passing it as a command-line flag, so the token is not exposed through process listings.

Daemon mode writes stable files under `~/.agent-loom` by default:

```text
~/.agent-loom/agent-loom.pid
~/.agent-loom/logs/agent-loom.log
~/.agent-loom/state.sqlite
```

Set `AGENT_LOOM_HOME` to move those daemon files. If `AGENT_LOOM_STATE_DB_PATH` is already set, daemon mode preserves it instead of using `~/.agent-loom/state.sqlite`.

To compile a standalone Bun binary for the CLI:

```bash
bun run package
```

## Codex CLI and Desktop setup

Agent Loom can be configured as a Codex custom Responses provider. Start the local bridge with a stable API key:

```bash
export AGENT_LOOM_API_KEY="replace-with-at-least-16-characters"
bunx agent-loom start
```

Then configure Codex:

```bash
bunx agent-loom config codex
```

For local development from this repository, the equivalent commands are `bun run dev` and `bun run config:codex`. The config command safely creates or updates `~/.codex/config.toml`, preserving unrelated Codex config and writing a `.agent-loom-backup-*` backup before changing an existing file. It writes the equivalent provider and profile config:

```toml
profile = "agent-loom"
model_provider = "agent-loom"
model = "copilot-agent"

[model_providers.agent-loom]
name = "Agent Loom"
base_url = "http://127.0.0.1:8000/openai/v1"
wire_api = "responses"
env_key = "AGENT_LOOM_API_KEY"
requires_openai_auth = false
supports_websockets = false

[profiles.agent-loom]
model_provider = "agent-loom"
model = "copilot-agent"
```

Codex CLI and Desktop share this config. The top-level `profile`, `model_provider`, and `model` entries keep commands such as `codex exec resume --last` on Agent Loom even when the subcommand does not accept `--profile`. The `/openai/v1/models` route returns a Codex-compatible model catalog entry for `copilot-agent`, including `slug`, `display_name`, `shell_type`, `visibility`, and API/tooling metadata expected by Codex model selection.

Current compatibility scope:

- Codex-style non-empty `tools`, `tool_choice`, and `parallel_tool_calls` request fields are accepted as client capability metadata for the text bridge.
- Codex HTTP/SSE full-history `input[]` requests are parsed into system instructions, conversation history, and the latest user message before invoking the Copilot CLI backend.
- Streaming completion, failure, cancellation, and interruption events include stable response IDs plus Codex-compatible `error`, `incomplete_details`, and `usage` fields.

Agent Loom does not yet implement a bridge-owned Codex tool-call broker. The current bridge is text-first: it accepts Codex tool definitions so real Codex clients can connect, but it does not emit tool calls for Codex to execute.
