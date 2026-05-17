# Goal State

objective: "好的，根据 @plans/research-grade-runtime/ 来进行实现，确保和 design align，但尽量避免 over-design/over-engineering。所有的逻辑都需要有 UT 和 IT 测试覆盖，原子化 commit，多 review 和 refine，直到全部做完。"
status: active
slug: "research-grade-runtime"
turns_used: 4
turn_budget: null
docs_update_approved: true
created_at: "2026-05-17T16:43:23+08:00"
updated_at: "2026-05-17T16:49:27+08:00"

## Acceptance criteria

### User-visible behavior

- Volare exposes the approved research-grade runtime improvements from `plans/research-grade-runtime/` without becoming a research/RAG product.
- The implementation can distinguish transport success from grounding evidence using safe observability, explicit capability audit, and producer-gated provenance.
- Default behavior remains secure: builtin Copilot MCPs stay disabled unless explicitly configured, local endpoints remain bearer-authenticated, and CORS remains disabled.

### Implementation scope

- Implement the approved phases in order: Phase 0, Phase 1a, Phase 1b, Phase 1c, Phase 2, Phase 3, Phase 4, and conditional Phase 5 only if its producer gate is met.
- Keep each change atomic and aligned with `design.md`, `plan.md`, and `todo.md`.
- Avoid over-design: no hard-coded 13F logic, no Volare-owned RAG/search/browser/vector/reranker pipeline, no answer rewriting/blocking, and no tool broker without a concrete producer/consumer.

### Validation

- Every logic change has unit and integration coverage appropriate to the phase.
- Before each implementation commit, run the relevant targeted tests and required repository checks for that slice.
- Run `bun run check` and `bun run test` for code-changing slices, plus `bun run package` when CLI startup/config behavior changes.
- Run deeper review after coherent milestones and resolve or explicitly defer findings.

### Docs/status

- Keep `plans/research-grade-runtime/todo.md` and this `goal.md` current as implementation progresses.
- Update directly related docs required by the approved plan; use the docs approval workflow for broader or high-impact documentation changes.
- Record evidence for completed checklist items before committing each slice.

### Deferred/out of scope

- Conditional Phase 5 source refs and OpenAI source metadata are deferred unless a concrete Volare-observable source producer exists or is implemented in the same PR.
- A durable security-journal mirror for `turn.audit` is deferred to a later design.
- A Volare-owned tool broker is deferred until a concrete producer, consumer, approval model, and redaction model exist.

## Progress log

- Turn 0: Goal registered. Approved plan is committed at `f587f5a`.
- Turn 1: Phase 0 bounded raw grounding scanner implemented with UTF-8 byte-boundary tests.
- Turn 2: Generic URL redaction hardened without changing Biome rules.
- Turn 3: Phase 0 backend log fields and aggregate live-turn metrics implemented.
- Turn 4: Phase 0 baseline corpus fixture evidence captured.

## Deferred items

- Conditional Phase 5 source refs and OpenAI source metadata. reason=blocked_by_dependency until a concrete source producer exists.
- Durable `security` journal mirror for `turn.audit`. reason=future_phase.
- Volare-owned tool broker. reason=future_phase.

## Blockers

- None.
