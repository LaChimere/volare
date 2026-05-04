# Codex integration

Volare can be used as a Codex custom provider that speaks the OpenAI Responses wire API.

## Configure Codex

Set up Volare and Codex with a stable token:

```bash
bunx @lachimere/volare setup
bunx @lachimere/volare start -d
```

The setup command generates or reuses `VOLARE_API_KEY`, saves it under `~/.volare/env`, updates the macOS GUI environment for Codex Desktop, and writes Codex config. Restart Codex Desktop after setup so it can read the saved token. If setup generates a new token while the daemon is already running, restart the daemon before reconnecting Codex Desktop. It updates `~/.codex/config.toml`, preserves unrelated settings, and creates a `.volare-backup-*` backup before changing an existing file.

Optional flags are available for non-default installs:

```bash
bunx @lachimere/volare setup \
  --config /path/to/config.toml \
  --base-url http://127.0.0.1:8000/openai/v1

bunx @lachimere/volare config codex \
  --config /path/to/config.toml \
  --base-url http://127.0.0.1:8000/openai/v1 \
  --env-key VOLARE_API_KEY
```

It writes the equivalent provider/profile:

```toml
profile = "volare"
model_provider = "volare"
model = "gpt-5.5"

[model_providers.volare]
name = "Volare"
base_url = "http://127.0.0.1:8000/openai/v1"
wire_api = "responses"
env_key = "VOLARE_API_KEY"
requires_openai_auth = true
supports_websockets = false

[profiles.volare]
model_provider = "volare"
model = "gpt-5.5"
```

Codex CLI and Desktop share this config. The top-level `profile`, `model_provider`, and `model` entries keep commands such as `codex exec resume --last` on Volare even when a subcommand does not accept `--profile`.

`requires_openai_auth = true` keeps Codex/Desktop aware of the signed-in ChatGPT account while `env_key = "VOLARE_API_KEY"` still authenticates requests to the local Volare server. This lets Desktop expose ChatGPT-backed plugin browsing and installation while using Volare as the active model provider.

## Model catalog

`GET /openai/v1/models` returns a Codex-compatible model catalog entry for `gpt-5.5` (`GPT-5.5` in Codex/Desktop), including fields such as `slug`, `display_name`, `shell_type`, `visibility`, API support metadata, truncation policy, modalities, and context window metadata. The same route is also available as `GET /v1/models` for clients that use the standard OpenAI base path.

## Supported Responses behavior

Volare currently supports the text bridge subset needed by Codex CLI/Desktop:

- `POST /openai/v1/responses` with streaming SSE responses.
- `GET /openai/v1/responses/:id` for stored response lookup.
- `POST /openai/v1/responses/:id/cancel` for cancellation.
- `/v1/*` aliases for the model and response routes.
- `previous_response_id` resolution through durable client refs.
- Full-history `input[]` parsing into system instructions, conversation history, the latest user message, and image/file attachment summaries.
- Request `metadata` and Codex `client_metadata` echoing on encoded Responses snapshots for client correlation.
- Non-empty `tools`, `tool_choice`, and `parallel_tool_calls` request fields as client capability metadata.
- Explicit rejection of `stream: false`; Volare streams every response.
- Compatibility acceptance for unsupported Codex controls such as `reasoning` and `text` so ordinary Codex CLI/Desktop requests are not blocked. Volare does not advertise reasoning or verbosity controls, so these fields are currently ignored.
- Terminal `response.completed`, `response.failed`, and `response.incomplete` events.
- Standard `usage` fields with best-effort estimated token counts.

## Current limitations

Volare does not yet implement a bridge-owned tool-call broker. It accepts Codex tool definitions so clients can connect, but it does not emit tool calls for Codex to execute.

Image and file content parts are preserved as attachment summaries and passed to the backend prompt as client-provided context. Volare does not yet provide binary or vision-model execution for those attachments.

ChatGPT-backed plugin browsing and installation can remain available through Codex/Desktop account state. Actually executing plugin-provided tools through Volare still depends on the current bridge limitation: Volare does not yet route client-side plugin tool calls back to Codex for execution.

Copilot CLI is invoked with the configured permission mode. By default, Volare uses `VOLARE_COPILOT_PERMISSION_MODE=full`, which grants the Copilot CLI subprocess URL, shell/tool, and path permissions for trusted local Codex/Desktop dogfooding:

```text
copilot --no-color --no-custom-instructions --disable-builtin-mcps --allow-all --log-level error --stream on --output-format json --prompt <prompt>
```

Set `VOLARE_COPILOT_PERMISSION_MODE=web` to allow only public URL fetches, or `VOLARE_COPILOT_PERMISSION_MODE=restricted` to pass no non-interactive grants. The same setting is available as `volare start --copilot-permission-mode <restricted|web|full>`.

Codex UI/Desktop "Full access" controls Codex client tools; it is not automatically forwarded through the Responses API to the Copilot CLI subprocess. Use Volare's `full` mode when you intentionally want the Copilot CLI subprocess to have URL, shell/tool, and path grants too.

Volare observes stdout/stderr and process lifecycle but does not broker individual Copilot CLI internal tools as OpenAI Responses tool calls. Full Codex client-executed tool calls require a future bridge-owned tool-call broker.

## Context and workspace expectations

By default, Codex/Desktop requests without `metadata.workspace_root` run against Volare's projectless workspace. Codex/Desktop may still include their own conversation, UI, or temporary workspace context inside request text. Volare labels backend prompts with bridge context so the backend can distinguish client-provided context from files available in the backend cwd.
