# Codex integration

Agent Loom can be used as a Codex custom provider that speaks the OpenAI Responses wire API.

## Configure Codex

Start Agent Loom with a stable token:

```bash
export AGENT_LOOM_API_KEY="replace-with-at-least-16-characters"
bunx @lachimere/agent-loom start -d
```

Write Codex config:

```bash
bunx @lachimere/agent-loom config codex
```

The command updates `~/.codex/config.toml`, preserves unrelated settings, and creates a `.agent-loom-backup-*` backup before changing an existing file.

Optional flags are available for non-default installs:

```bash
bunx @lachimere/agent-loom config codex \
  --config /path/to/config.toml \
  --base-url http://127.0.0.1:8000/openai/v1 \
  --env-key AGENT_LOOM_API_KEY
```

It writes the equivalent provider/profile:

```toml
profile = "agent-loom"
model_provider = "agent-loom"
model = "copilot-agent"

[model_providers.agent-loom]
name = "Agent Loom"
base_url = "http://127.0.0.1:8000/openai/v1"
wire_api = "responses"
env_key = "AGENT_LOOM_API_KEY"
requires_openai_auth = true
supports_websockets = false

[profiles.agent-loom]
model_provider = "agent-loom"
model = "copilot-agent"
```

Codex CLI and Desktop share this config. The top-level `profile`, `model_provider`, and `model` entries keep commands such as `codex exec resume --last` on Agent Loom even when a subcommand does not accept `--profile`.

`requires_openai_auth = true` keeps Codex/Desktop aware of the signed-in ChatGPT account while `env_key = "AGENT_LOOM_API_KEY"` still authenticates requests to the local Agent Loom server. This lets Desktop expose ChatGPT-backed plugin browsing and installation while using Agent Loom as the active model provider.

## Model catalog

`GET /openai/v1/models` returns a Codex-compatible model catalog entry for `copilot-agent`, including fields such as `slug`, `display_name`, `shell_type`, `visibility`, API support metadata, truncation policy, modalities, and context window metadata.

## Supported Responses behavior

Agent Loom currently supports the text bridge subset needed by Codex CLI/Desktop:

- `POST /openai/v1/responses` with streaming SSE responses.
- `GET /openai/v1/responses/:id` for stored response lookup.
- `POST /openai/v1/responses/:id/cancel` for cancellation.
- `previous_response_id` resolution through durable client refs.
- Full-history `input[]` parsing into system instructions, conversation history, and the latest user message.
- Non-empty `tools`, `tool_choice`, and `parallel_tool_calls` request fields as client capability metadata.
- Terminal `response.completed`, `response.failed`, and `response.incomplete` events.
- Standard `usage` fields with best-effort estimated token counts.

## Current limitations

Agent Loom does not yet implement a bridge-owned tool-call broker. It accepts Codex tool definitions so clients can connect, but it does not emit tool calls for Codex to execute.

ChatGPT-backed plugin browsing and installation can remain available through Codex/Desktop account state. Actually executing plugin-provided tools through Agent Loom still depends on the current bridge limitation: Agent Loom does not yet route client-side plugin tool calls back to Codex for execution.

Copilot CLI is invoked with the configured permission mode. By default, Agent Loom uses `AGENT_LOOM_COPILOT_PERMISSION_MODE=full`, which grants the Copilot CLI subprocess URL, shell/tool, and path permissions for trusted local Codex/Desktop dogfooding:

```text
copilot --no-color --no-custom-instructions --disable-builtin-mcps --allow-all --log-level error --stream on --output-format json --prompt <prompt>
```

Set `AGENT_LOOM_COPILOT_PERMISSION_MODE=web` to allow only public URL fetches, or `AGENT_LOOM_COPILOT_PERMISSION_MODE=restricted` to pass no non-interactive grants. The same setting is available as `agent-loom start --copilot-permission-mode <restricted|web|full>`.

Codex UI/Desktop "Full access" controls Codex client tools; it is not automatically forwarded through the Responses API to the Copilot CLI subprocess. Use Agent Loom's `full` mode when you intentionally want the Copilot CLI subprocess to have URL, shell/tool, and path grants too.

Agent Loom observes stdout/stderr and process lifecycle but does not broker individual Copilot CLI internal tools as OpenAI Responses tool calls. Full Codex client-executed tool calls require a future bridge-owned tool-call broker.

## Context and workspace expectations

By default, Codex/Desktop requests without `metadata.workspace_root` run against Agent Loom's projectless workspace. Codex/Desktop may still include their own conversation, UI, or temporary workspace context inside request text. Agent Loom labels backend prompts with bridge context so the backend can distinguish client-provided context from files available in the backend cwd.
