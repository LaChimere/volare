# Goal State

objective: "我觉得我们接下来的目标是 fill gaps，你可以调研下上面这些 gaps 哪些是需要我们 fill 的，按优先级排序，然后从高到低 support。我们还是面向接口，但不引入 over-design。你需要多 review 和 refine。usage 这块暂时不用做。 另外，你可以看一下我们的 bunx @lachimere/volare xxx 这样的 cli 能力是否有需要 improve 的，也可以打磨下。"
status: complete
slug: "goal-fill-codex-gaps"
turns_used: 3
turn_budget: null
docs_update_approved: true
created_at: "2026-05-04T17:43:23+08:00"
updated_at: "2026-05-04T18:25:00+08:00"

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
- Turn 2: Implemented first interface-safe gap slice: Responses attachment extraction, metadata echo on Responses snapshots, explicit stream=false rejection, backend attachment prompt summaries, CLI daemon API-key warning, and clearer invalid command/permission-mode errors. Independent code review found and the implementation fixed attachment leakage from historical messages into the latest turn. Validation passed with targeted tests, `bun run check`, `bun run test`, and `bun run package`.
- Turn 3: Added Codex `client_metadata` compatibility and explicit rejection for unsupported reasoning/text controls, with tests and documentation. Final independent review found no blocking issues.

## Deferred items

- Usage/token accounting improvements; reason=out_of_scope.
- Broad protocol expansion and remote/multi-user deployment; reason=out_of_scope.

## Blockers

- None.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: Codex CLI/Desktop compatibility gaps are researched, ranked, and acted on from highest useful priority first. | Research prioritized the strategic tool-call broker as too broad for the first safe slice, then implemented interface-safe Responses input fidelity, metadata, unsupported control clarity, and CLI UX fixes in commits `10f6765` and `f405f2b`. | met |
| User-visible behavior: Implemented work stays interface-oriented and avoids broad runtime redesign. | Changes are contained to the OpenAI Responses adapter, protocol-neutral request/event types, session metadata propagation, backend prompt framing, CLI messages, tests, and direct docs; no tool-execution framework or runtime rewrite was introduced. | met |
| User-visible behavior: Usage accounting changes are explicitly deferred. | No usage accounting implementation was changed; final independent review verified usage remained untouched. | met |
| User-visible behavior: `bunx @lachimere/volare ...` CLI behavior is reviewed and improved where small, high-value refinements are found. | CLI now warns when daemon mode starts without `VOLARE_API_KEY`, and invalid command/permission-mode errors are clearer with tests in `tests/unit_tests/cli.test.ts`. | met |
| Implementation scope: Inspect Codex-facing adapter, HTTP routes, session/core event boundaries, backend prompt bridge, tests, docs, and CLI entrypoint. | Work touched and tested `src/northbound/openai-responses/adapter.ts`, `src/server/app.ts`, session managers, `src/core/types.ts`, `src/backends/copilot-cli/backend.ts`, docs, and CLI tests. | met |
| Implementation scope: Implement the highest-priority gap slice that is clearly needed and safe to support now. | Attachment summaries, request metadata echo, Codex `client_metadata`, explicit `stream:false`/reasoning/text rejections, and prompt summaries were implemented with targeted regression coverage. | met |
| Implementation scope: Implement small CLI UX refinements when they reduce user friction without changing core semantics. | CLI refinements are limited to warnings and clearer errors; command semantics are unchanged. | met |
| Implementation scope: Update directly related docs for confirmed behavior changes. | `docs/codex-integration.md`, `docs/configuration.md`, and `docs/operations.md` document the implemented behavior and limitations. | met |
| Validation: Add or update targeted tests for implemented behavior. | Added adapter, backend, and CLI unit tests for attachments, metadata/client_metadata, unsupported parameters, backend summaries, and CLI warnings/errors. | met |
| Validation: Run repository checks/tests relevant to the changes. | `bun run check`, `bun run test`, `bun run package`, and targeted adapter tests passed during the implementation slices. | met |
| Validation: Run multiple review/refinement passes, including independent review where useful. | Independent review caught and was followed by a fix for historical attachment leakage; final independent review found no blocking issues. | met |
| Docs/status: Keep this goal state updated with prioritization, progress, deferred items, blockers, and completion audit. | This file records progress, deferred work, blockers, and this completion audit. | met |
| Docs/status: Update README/docs only for implemented or explicitly deferred compatibility/CLI behavior. | Docs updates are limited to implemented Codex integration/configuration/operations behavior. | met |
| Deferred/out of scope: Usage/token accounting improvements are out of scope for this goal. | Deferred item retained as out of scope. | deferred-out-of-scope |
| Deferred/out of scope: Broad protocol expansion, `/chat/completions`, Anthropic/Gemini adapters, full MCP management, and remote multi-user deployment are out of scope unless a narrow interface requirement proves otherwise. | No broad protocol or remote deployment work was added. | deferred-out-of-scope |
| Deferred/out of scope: Rewriting the core runtime or introducing a large tool-execution framework before the interface shape is proven is out of scope. | Tool-call broker remains a strategic deferred item rather than an over-designed first implementation. | deferred-out-of-scope |
