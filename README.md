# Volare

Volare is a local agent-runtime bridge backed by Copilot CLI. It currently exposes an OpenAI Responses-compatible API for Codex CLI/Desktop dogfooding, while keeping the core runtime protocol-neutral for durable local state, projectless chats, structured diagnostics, and Bun-native operation.

## Quick start

Set up a stable local token and Codex CLI/Desktop config:

```bash
bunx @lachimere/volare setup
bunx @lachimere/volare start -d
```

The setup command generates or reuses `VOLARE_API_KEY`, saves it under `~/.volare/env`, configures Codex for `gpt-5.5` with high reasoning in a Volare-managed config block, and updates the macOS GUI environment for Codex Desktop. Restart Codex Desktop after setup. The server listens on `http://127.0.0.1:8000/openai/v1` by default, also accepts OpenAI-compatible `/v1` aliases, and requires bearer auth for every endpoint. Daemon helpers:

```bash
bunx @lachimere/volare status
bunx @lachimere/volare logs
```

If you rerun setup with `--force` while the daemon is already running, restart the daemon before reconnecting Codex Desktop so both processes use the same token.

`bunx` requires Bun to be installed locally. Volare does not target Node-only `npx` execution in this release track.

Upgrade the `bunx`-resolved package cache:

```bash
bunx @lachimere/volare update
```

This clears Bun's global package cache and resolves `@lachimere/volare@latest`, so unrelated `bunx` tools may be reinstalled the next time you run them.

## Documentation

- [Architecture](docs/architecture.md) - runtime components, request flow, state, and protocol boundaries.
- [Configuration](docs/configuration.md) - environment variables, CLI options, auth, workspace selection, and daemon paths.
- [Codex integration](docs/codex-integration.md) - Codex provider setup, supported Responses behavior, and current compatibility scope.
- [Operations](docs/operations.md) - health checks, logs, metrics, debug journal, shutdown, and troubleshooting.
- [Testing](docs/testing.md) - current test commands and layer ownership.
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

The model and response routes are also available under `/v1/*` for clients that expect the standard OpenAI base path.

## Commands

```bash
bunx @lachimere/volare help
bunx @lachimere/volare setup         # generate/persist token and configure Codex
bunx @lachimere/volare start         # foreground server
bunx @lachimere/volare start -d      # daemon server
bunx @lachimere/volare status        # daemon status
bunx @lachimere/volare stop          # stop daemon
bunx @lachimere/volare logs          # print daemon log path
bunx @lachimere/volare update        # refresh Bun's global cache to npm latest
bunx @lachimere/volare config codex          # configure or repair Codex CLI/Desktop
bunx @lachimere/volare config codex doctor   # diagnose Volare-owned Codex config drift
bunx @lachimere/volare config codex repair   # rewrite only Volare-owned Codex config
```

## Current compatibility scope

Volare accepts Codex-style non-empty `tools`, `tool_choice`, and `parallel_tool_calls` fields as client capability metadata for the text bridge. It parses Codex full-history `input[]` requests into system instructions, conversation history, and the latest user message before invoking Copilot CLI.

Streaming completion, failure, cancellation, and interruption events include stable response IDs plus Codex-compatible `error`, `incomplete_details`, and standard `usage` fields. Usage is currently a best-effort estimate based on the prompt text sent to the backend and assistant text returned to the client.

Volare does not yet implement a bridge-owned Codex tool-call broker. The current bridge is text-first: it accepts Codex tool definitions so real Codex clients can connect, but it does not emit tool calls for Codex to execute.
