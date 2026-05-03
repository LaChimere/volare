# Architecture

Agent Loom runs a local OpenAI Responses-compatible HTTP server and translates requests into a protocol-neutral agent runtime. The production runtime currently uses Copilot CLI as the backend.

## Component map

| Area | Path | Responsibility |
|---|---|---|
| Runtime wiring | `src/runtime/server.ts` | Build config, logger, SQLite database, state store, event journal, session manager, backend, and HTTP server. |
| HTTP app | `src/server/app.ts` | Bearer auth, routing, request logging, workspace resolution, SSE response streaming, health, metrics, and debug endpoints. |
| Protocol adapter | `src/northbound/openai-responses/adapter.ts` | Parse OpenAI Responses requests, encode SSE/stored responses, expose Codex model metadata. |
| Core runtime | `src/core/` | Protocol-neutral types, durable session manager, in-memory session manager, workspace resolver, errors, and usage estimation. |
| Backend | `src/backends/copilot-cli/` | Spawn Copilot CLI, parse JSON/plain output, track/cancel processes, and frame backend prompts. |
| State | `src/state/` | SQLite schema, durable workspaces, threads, turns, backend sessions, approvals, and startup recovery. |
| Event journal | `src/events/` | Canonical/debug event persistence, redaction, replay, and retention pruning. |
| CLI | `src/cli.ts` | Foreground/daemon startup, status, stop, logs, and Codex config commands. |

## Request flow

1. A client sends `POST /openai/v1/responses` with bearer auth.
2. `createApp()` parses JSON and asks the adapter for workspace hints.
3. `WorkspaceResolver` chooses a workspace:
   - explicit `metadata.workspace_root` uses the requested root after allowlist checks;
   - otherwise the request uses the configured projectless workspace.
4. `OpenAIResponsesAdapter.parseRequest()` converts the client body into protocol-neutral `IAgentRequestInput`.
5. `DurableSessionManager` creates or resumes thread/session state and starts a turn.
6. `CopilotCliBackend` frames a single prompt and runs `copilot --stream on --output-format json`.
7. Backend deltas become canonical `AgentEvent` values.
8. Events are journaled, logged, and encoded back to the client as Responses SSE events.
9. Terminal events complete, fail, cancel, or interrupt the turn and end the SSE stream with `[DONE]`.

## Protocol boundaries

Core runtime types intentionally do not contain OpenAI Responses wire shapes. Codex/OpenAI-specific request parsing, response encoding, model catalog fields, and stable external response IDs belong under `src/northbound/openai-responses/`.

The backend is also protocol-neutral from the session manager's perspective. It accepts `IAgentRequest`, yields `AgentEvent`, and owns only the mechanics needed to run Copilot CLI.

## Workspace isolation

Agent Loom defaults to projectless workspace isolation. Requests without `metadata.workspace_root` run from `${TMPDIR:-/tmp}/al-projectless-workspace` by default, which prevents generic Codex/Desktop chats from inheriting the Agent Loom repository context.

If a client explicitly sends `metadata.workspace_root`, Agent Loom treats that as a requested workspace and validates it against configured allowlist roots when present.

## Context provenance

Copilot backend prompts start with an `Agent Loom bridge context` section. It tells the backend whether the client explicitly requested a workspace and whether the backend cwd is a neutral projectless workspace. This helps the model distinguish backend filesystem context from client-provided conversation or Desktop/Codex context.

## Durable state and replay

SQLite stores workspaces, threads, turns, backend sessions, client response references, approvals, and journal events. Startup recovery interrupts non-terminal turns and abandons non-terminal backend sessions so restarts do not leave ambiguous active state.

The debug journal stores canonical events and supports replay through `GET /debug/turns/:id/events`. Redaction is fail-closed: if redaction fails, Agent Loom records a security marker when possible and preserves the original failure.

## Usage accounting

Codex/Desktop expect standard `usage` fields. Copilot CLI does not currently expose authoritative token accounting through this bridge, so Agent Loom emits conservative estimates based on the prompt text sent to the backend and the assistant text returned to the client. The wire output remains standard OpenAI-style `input_tokens`, `output_tokens`, `total_tokens`, and token detail fields.
