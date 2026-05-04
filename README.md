# Volare

Volare is a local agent-runtime bridge backed by Copilot CLI. It currently exposes an OpenAI Responses-compatible API for Codex CLI/Desktop dogfooding, while keeping the core runtime protocol-neutral for durable local state, projectless chats, structured diagnostics, and Bun-native operation.

## Quick start

Start the bridge with a stable token:

```bash
export VOLARE_API_KEY="replace-with-at-least-16-characters"
bunx @lachimere/volare start
```

The server listens on `http://127.0.0.1:8000/openai/v1` by default and requires bearer auth for every endpoint. For a background daemon:

```bash
bunx @lachimere/volare start -d
bunx @lachimere/volare status
bunx @lachimere/volare logs
```

Configure Codex CLI/Desktop:

```bash
bunx @lachimere/volare config codex
```

`bunx` requires Bun to be installed locally. Volare does not target Node-only `npx` execution in this release track.

## Documentation

- [Architecture](docs/architecture.md) - runtime components, request flow, state, and protocol boundaries.
- [Configuration](docs/configuration.md) - environment variables, CLI options, auth, workspace selection, and daemon paths.
- [Codex integration](docs/codex-integration.md) - Codex provider setup, supported Responses behavior, and current compatibility scope.
- [Operations](docs/operations.md) - health checks, logs, metrics, debug journal, shutdown, and troubleshooting.
- [Development](docs/development.md) - repository workflow, tests, naming conventions, packaging, and review expectations.

## Useful endpoints

```text
GET  /healthz
GET  /metrics
GET  /openai/v1/models
POST /openai/v1/responses
GET  /openai/v1/responses/:id
POST /openai/v1/responses/:id/cancel
GET  /debug/turns/:id/events
```

## Commands

```bash
bunx @lachimere/volare help
bunx @lachimere/volare start         # foreground server
bunx @lachimere/volare start -d      # daemon server
bunx @lachimere/volare status        # daemon status
bunx @lachimere/volare stop          # stop daemon
bunx @lachimere/volare logs          # print daemon log path
bunx @lachimere/volare config codex  # configure Codex CLI/Desktop
```

## Current compatibility scope

Volare accepts Codex-style non-empty `tools`, `tool_choice`, and `parallel_tool_calls` fields as client capability metadata for the text bridge. It parses Codex full-history `input[]` requests into system instructions, conversation history, and the latest user message before invoking Copilot CLI.

Streaming completion, failure, cancellation, and interruption events include stable response IDs plus Codex-compatible `error`, `incomplete_details`, and standard `usage` fields. Usage is currently a best-effort estimate based on the prompt text sent to the backend and assistant text returned to the client.

Volare does not yet implement a bridge-owned Codex tool-call broker. The current bridge is text-first: it accepts Codex tool definitions so real Codex clients can connect, but it does not emit tool calls for Codex to execute.
