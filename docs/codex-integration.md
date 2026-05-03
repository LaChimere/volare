# Codex integration

Agent Loom can be used as a Codex custom provider that speaks the OpenAI Responses wire API.

## Configure Codex

Start Agent Loom with a stable token:

```bash
export AGENT_LOOM_API_KEY="replace-with-at-least-16-characters"
bun run src/cli.ts start -d
```

Write Codex config:

```bash
bun run src/cli.ts config codex
```

The command updates `~/.codex/config.toml`, preserves unrelated settings, and creates a `.agent-loom-backup-*` backup before changing an existing file.

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
requires_openai_auth = false
supports_websockets = false

[profiles.agent-loom]
model_provider = "agent-loom"
model = "copilot-agent"
```

Codex CLI and Desktop share this config. The top-level `profile`, `model_provider`, and `model` entries keep commands such as `codex exec resume --last` on Agent Loom even when a subcommand does not accept `--profile`.

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

Copilot CLI is invoked with:

```text
copilot --no-color --no-custom-instructions --disable-builtin-mcps --log-level error --stream on --output-format json --prompt <prompt>
```

That means Copilot CLI owns its internal tool and permission behavior. Agent Loom observes stdout/stderr and process lifecycle but does not broker individual Copilot CLI internal tools as OpenAI Responses tool calls.

## Context and workspace expectations

By default, Codex/Desktop requests without `metadata.workspace_root` run against Agent Loom's projectless workspace. Codex/Desktop may still include their own conversation, UI, or temporary workspace context inside request text. Agent Loom labels backend prompts with bridge context so the backend can distinguish client-provided context from files available in the backend cwd.
