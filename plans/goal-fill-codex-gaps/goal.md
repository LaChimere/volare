# Goal State

objective: "我觉得我们接下来的目标是 fill gaps，你可以调研下上面这些 gaps 哪些是需要我们 fill 的，按优先级排序，然后从高到低 support。我们还是面向接口，但不引入 over-design。你需要多 review 和 refine。usage 这块暂时不用做。 另外，你可以看一下我们的 bunx @lachimere/volare xxx 这样的 cli 能力是否有需要 improve 的，也可以打磨下。"
status: active
slug: "goal-fill-codex-gaps"
turns_used: 3
turn_budget: null
docs_update_approved: true
created_at: "2026-05-04T17:43:23+08:00"
updated_at: "2026-05-04T18:16:00+08:00"

## Acceptance criteria

### User-visible behavior

- Codex CLI/Desktop compatibility gaps are researched, ranked, and acted on from highest useful priority first.
- Implemented work stays interface-oriented and avoids broad runtime redesign.
- Usage accounting changes are explicitly deferred.
- `bunx @lachimere/volare ...` CLI behavior is reviewed and improved where small, high-value refinements are found.

### Implementation scope

- Inspect Codex-facing adapter, HTTP routes, session/core event boundaries, backend prompt bridge, tests, docs, and CLI entrypoint.
- Implement the highest-priority gap slice that is clearly needed and safe to support now.
- Implement small CLI UX refinements when they reduce user friction without changing core semantics.
- Update directly related docs for confirmed behavior changes.

### Validation

- Add or update targeted tests for implemented behavior.
- Run repository checks/tests relevant to the changes.
- Run multiple review/refinement passes, including independent review where useful.

### Docs/status

- Keep this goal state updated with prioritization, progress, deferred items, blockers, and completion audit.
- Update README/docs only for implemented or explicitly deferred compatibility/CLI behavior.

### Deferred/out of scope

- Usage/token accounting improvements are out of scope for this goal.
- Broad protocol expansion, `/chat/completions`, Anthropic/Gemini adapters, full MCP management, and remote multi-user deployment are out of scope unless a narrow interface requirement proves otherwise.
- Rewriting the core runtime or introducing a large tool-execution framework before the interface shape is proven is out of scope.

## Progress log

- Turn 0: Goal registered. Next slice is to research and prioritize Codex CLI/Desktop gaps and CLI UX refinements.
- Turn 1: Research completed. Prioritization: (1) full tool-call broker is highest strategic gap but too broad for first slice; (2) Responses input fidelity/metadata echo/unsupported parameter clarity are first interface-safe implementation targets; (3) CLI API-key and error-message refinements are high-value bunx UX work. Usage remains deferred.

## Deferred items

- Usage/token accounting improvements; reason=out_of_scope.
- Broad protocol expansion and remote/multi-user deployment; reason=out_of_scope.

## Blockers

- None.

- Turn 2: Implemented first interface-safe gap slice: Responses attachment extraction, metadata echo on Responses snapshots, explicit stream=false rejection, backend attachment prompt summaries, CLI daemon API-key warning, and clearer invalid command/permission-mode errors. Independent code review found and the implementation fixed attachment leakage from historical messages into the latest turn. Validation passed with targeted tests, `bun run check`, `bun run test`, and `bun run package`.
- Turn 3: Added Codex `client_metadata` compatibility and explicit rejection for unsupported reasoning/text controls, with tests and documentation.
