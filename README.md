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

Configuration defaults are local and restrictive: host `127.0.0.1`, port `8000`, CORS disabled, state database `.agent-loom/state.sqlite`, approval timeout `60000ms`, cancel timeout `10000ms`, disconnect grace `5000ms`, and event retention disabled unless `AGENT_LOOM_EVENT_RETENTION_DAYS` is set.

To compile a standalone Bun binary:

```bash
bun run package
```

## Codex CLI and Desktop setup

Agent Loom can be configured as a Codex custom Responses provider. Start the local bridge with a stable API key:

```bash
export AGENT_LOOM_API_KEY="replace-with-at-least-16-characters"
bun run dev
```

Then configure Codex:

```bash
bun run config:codex
```

The script safely creates or updates `~/.codex/config.toml`, preserving unrelated Codex config and writing a `.agent-loom-backup-*` backup before changing an existing file. It writes the equivalent provider and profile config:

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
