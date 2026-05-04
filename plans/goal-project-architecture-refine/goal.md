# Goal State

objective: "好的，对于整个项目，你可以多调研、review 和 rethink 下，看看当前的架构、设计和实现有哪里是不合理的或者需要改进的，你可以打磨下，但不要引入 over-design"
status: complete
slug: "goal-project-architecture-refine"
turns_used: 2
turn_budget: null
docs_update_approved: false
created_at: "2026-05-04T14:44:19+08:00"
updated_at: "2026-05-04T15:00:57+08:00"

## Acceptance criteria

### User-visible behavior

- Identify current architecture/design/implementation issues that are genuinely worth addressing.
- Apply small, low-risk refinements where the fix is clear and avoids over-design.
- Clearly separate completed refinements from deferred larger architectural work.

### Implementation scope

- Review core runtime boundaries, request/response adapter behavior, backend integration, state/events, CLI/config, docs, and tests.
- Prefer surgical fixes, consistency improvements, and missing validation/tests over new abstractions.
- Do not introduce broad framework changes, new dependencies, or speculative plugin/tool-broker architecture.

### Validation

- Run relevant targeted tests for changed surfaces.
- Run repository checks/tests/package before completion if code or CLI behavior changes.
- Use at least one independent review pass after refinements.

### Docs/status

- Keep this goal state updated with findings, decisions, validation, and deferred items.
- Update project docs only when behavior/configuration/API guidance changes.

### Deferred/out of scope

- Full bridge-owned client tool-call broker is out of scope unless a small enabling fix is discovered.
- Large rewrites, dependency swaps, or protocol redesigns are out of scope for this pass.

## Progress log

- Turn 0: Goal registered.
- Turn 1: Completed multi-agent and local architecture review. Selected small, high-value refinements instead of larger deferred architecture work.
- Turn 2: Implemented and validated targeted reliability/config/protocol refinements:
  - Shutdown now force-stops even if graceful stop or recovery fails, while preserving collected errors.
  - SSE cancellation now attempts both cancel handling and iterator cleanup before surfacing errors.
  - Copilot CLI stream parse/read failures now terminate the child process, collect stderr/exit context, and untrack safely.
  - Codex config generation now validates base URL/env key inputs and rejects TOML-unsafe control characters.
  - Stored durable Responses GET now falls back to canonical journal replay after manager restart.
  - Streaming completed responses now preserve real model and creation timestamp metadata.
  - Added targeted tests and updated related docs for configuration, Codex setup, and operations events.

## Deferred items

- Bridge-owned client tool-call broker for plugin/tool execution remains deferred; reason=future_phase.
- Approval-request redaction overhaul remains deferred because it touches persistence policy more broadly; reason=future_phase.
- Larger runtime/protocol redesigns remain deferred to avoid over-design; reason=out_of_scope.

## Blockers

- None.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: Identify current architecture/design/implementation issues that are genuinely worth addressing. | Multi-agent and local review identified shutdown cleanup, SSE cancel cleanup, Copilot process cleanup, Codex config validation, durable response replay, stream metadata, and docs/test gaps as small high-value targets. | met |
| User-visible behavior: Apply small, low-risk refinements where the fix is clear and avoids over-design. | Updated `src/server/shutdown.ts`, `src/server/app.ts`, `src/backends/copilot-cli/backend.ts`, `scripts/config-codex.ts`, `src/northbound/openai-responses/adapter.ts`, and `src/core/types.ts` with surgical reliability/config/protocol fixes. | met |
| User-visible behavior: Clearly separate completed refinements from deferred larger architectural work. | Deferred items list records tool-call broker, approval redaction overhaul, and broad redesigns as future/out-of-scope work. | met |
| Implementation scope: Review core runtime boundaries, request/response adapter behavior, backend integration, state/events, CLI/config, docs, and tests. | Review covered runtime/server/app, adapter, Copilot backend, durable state/events, CLI/config script, docs, and unit tests. | met |
| Implementation scope: Prefer surgical fixes, consistency improvements, and missing validation/tests over new abstractions. | Changes add no new dependencies and no new framework abstractions; tests cover the changed boundaries. | met |
| Implementation scope: Do not introduce broad framework changes, new dependencies, or speculative plugin/tool-broker architecture. | No dependency/package changes; plugin/tool-call broker remains deferred. | met |
| Validation: Run relevant targeted tests for changed surfaces. | `bun test tests/unit_tests/server/shutdown.test.ts tests/unit_tests/server/app.test.ts tests/unit_tests/backends/copilot-cli-backend.test.ts tests/unit_tests/scripts/config-codex.test.ts tests/unit_tests/northbound/openai-responses-adapter.test.ts` passed. | met |
| Validation: Run repository checks/tests/package before completion if code or CLI behavior changes. | `bun run check && bun run test && bun run package` passed. | met |
| Validation: Use at least one independent review pass after refinements. | Code-review agent reviewed the uncommitted diff and reported no significant issues or over-engineering. | met |
| Docs/status: Keep this goal state updated with findings, decisions, validation, and deferred items. | This goal file records progress, deferred items, and this completion audit. | met |
| Docs/status: Update project docs only when behavior/configuration/API guidance changes. | Updated `docs/configuration.md`, `docs/codex-integration.md`, and `docs/operations.md` for behavior/config/log-event guidance. | met |
| Deferred/out of scope: Full bridge-owned client tool-call broker is out of scope unless a small enabling fix is discovered. | No tool-call broker was implemented; item is listed as deferred. | met |
| Deferred/out of scope: Large rewrites, dependency swaps, or protocol redesigns are out of scope for this pass. | No large rewrite, dependency swap, or broad protocol redesign was introduced. | met |
