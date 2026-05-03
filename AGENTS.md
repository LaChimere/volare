# Agent Loom agent guide

This repository is a Bun/TypeScript project for a local OpenAI Responses-compatible bridge backed by Copilot CLI. Prefer small, protocol-safe changes and keep the runtime easy to inspect locally.

## Tooling

- Use Bun commands: `bun install`, `bun run <script>`, `bun test`, `bunx <package> <command>`.
- Run `bun run check` and `bun run test` before committing code changes.
- Run `bun run package` when packaging or CLI startup behavior changes.
- Do not add alternate package managers or build tools unless the project explicitly needs them.

## Code conventions

- TypeScript interfaces use an `I` prefix, for example `IStateStore`.
- Concrete classes and functions do not use the `I` prefix.
- Keep core runtime types protocol-neutral. OpenAI Responses-specific IDs, wire shapes, and compatibility adapters belong in `src/northbound/openai-responses/`.
- Prefer explicit errors over broad catch-and-ignore behavior. Cleanup failures should be logged or surfaced without masking the original failure.
- Keep local HTTP endpoints bearer-authenticated, CORS-disabled by default, and hostile to unexpected browser origins.
- Use structured logger fields for diagnostics instead of ad hoc console output, except for intentional CLI/user-facing output.

## Runtime boundaries

- `src/runtime/server.ts` wires production dependencies.
- `src/server/app.ts` owns HTTP routing, auth, request logging, and SSE streaming.
- `src/core/` owns protocol-neutral state, sessions, approvals, workspace resolution, and event types.
- `src/northbound/openai-responses/` owns OpenAI/Codex request parsing and response encoding.
- `src/backends/copilot-cli/` owns Copilot CLI process integration and backend prompt framing.
- `src/state/` and `src/events/` own durable SQLite state and debug journal behavior.

## Documentation

- Keep `README.md` concise and link to detailed docs under `docs/`.
- Update docs when behavior, configuration, CLI commands, protocol compatibility, or operational workflows change.
- Preserve projectless workspace isolation in examples: generic Codex/Desktop chats should not inherit the Agent Loom repository context unless the client explicitly sends `metadata.workspace_root`.

## Security and privacy

- Never commit secrets or bearer tokens.
- Keep `AGENT_LOOM_API_KEY` in the environment, not in command-line flags.
- Redact sensitive request, shell, and journal data in diagnostics.
- Do not bypass content exclusion or local access policies when debugging.
