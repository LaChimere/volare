# Goal State

objective: "接下来，我们需要先为这个项目完善文档，项目的相关详细文档你可以写到 @docs 里面。你也需要看看 @README.md 和 @AGENTS.md 等文档是否需要 refine。"
status: complete
slug: "goal-project-documentation"
turns_used: 1
turn_budget: null
created_at: "2026-05-03T23:54:26.615+08:00"
updated_at: "2026-05-03T23:54:26.615+08:00"

## Acceptance criteria

- Add a useful `docs/` documentation set that explains Agent Loom architecture, configuration, Codex integration, operations, and development workflow.
- Refine `README.md` into a concise project overview and quick-start entrypoint that links to detailed docs.
- Refine `AGENTS.md` so future agents see current, project-specific conventions without stale guidance.
- Ensure package metadata includes docs where appropriate.
- Run available validation after documentation/package metadata changes.

## Progress log

- Turn 0: Goal registered. Assumption: detailed product and contributor docs should live in `docs/`, while README should stay short and action-oriented.
- Turn 1: Added the `docs/` guide set, refined `README.md` and `AGENTS.md`, included docs in package metadata, synchronized stale interface naming references in markdown, and validated with `bun run check`, `bun run test`, `bun run package`, and `bun pm pack --dry-run`.

## Deferred items

- Public website or generated API reference.

## Blockers

- None.
