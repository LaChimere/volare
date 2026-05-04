# Agent Loom

Agent Loom is a local bridge that exposes an OpenAI Responses-compatible API backed by a local Copilot CLI agent runtime. It is designed for Codex CLI/Desktop dogfooding, durable local state, projectless chats, structured diagnostics, and Bun-native operation.

## Quick start

Install dependencies:

```bash
bun install
```

Start the bridge with a stable token from a repository checkout:

```bash
export AGENT_LOOM_API_KEY="replace-with-at-least-16-characters"
bun run src/cli.ts start
```

The server listens on `http://127.0.0.1:8000/openai/v1` by default and requires bearer auth for every endpoint. For a background daemon:

```bash
bun run src/cli.ts start -d
bun run src/cli.ts status
bun run src/cli.ts logs
```

Configure Codex CLI/Desktop from a repository checkout:

```bash
bun run src/cli.ts config codex
```

After npm publication, the intended executable form is `bunx agent-loom ...`:

```bash
export AGENT_LOOM_API_KEY="replace-with-at-least-16-characters"
bunx agent-loom start
bunx agent-loom start -d
bunx agent-loom status
bunx agent-loom config codex
```

`bunx` requires Bun to be installed locally. Agent Loom does not target Node-only `npx` execution in this release track.

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
bun run src/cli.ts help
bun run src/cli.ts start                 # foreground server
bun run src/cli.ts start -d              # daemon server
bun run src/cli.ts status                # daemon status
bun run src/cli.ts stop                  # stop daemon
bun run src/cli.ts logs                  # print daemon log path
bun run src/cli.ts config codex          # configure Codex CLI/Desktop
bunx agent-loom config codex             # package executable after npm publication
bun run package                          # compile standalone Bun binary to dist/agent-loom
```

## Current compatibility scope

Agent Loom accepts Codex-style non-empty `tools`, `tool_choice`, and `parallel_tool_calls` fields as client capability metadata for the text bridge. It parses Codex full-history `input[]` requests into system instructions, conversation history, and the latest user message before invoking Copilot CLI.

Streaming completion, failure, cancellation, and interruption events include stable response IDs plus Codex-compatible `error`, `incomplete_details`, and standard `usage` fields. Usage is currently a best-effort estimate based on the prompt text sent to the backend and assistant text returned to the client.

Agent Loom does not yet implement a bridge-owned Codex tool-call broker. The current bridge is text-first: it accepts Codex tool definitions so real Codex clients can connect, but it does not emit tool calls for Codex to execute.
