# Goal State

objective: "按最佳实践来做"
status: complete
slug: "goal-codex-config-hygiene"
turns_used: 2
turn_budget: null
docs_update_approved: true
created_at: "2026-05-05T20:13:05+08:00"
updated_at: "2026-05-05T20:58:00+08:00"

## Acceptance criteria

### User-visible behavior

- Repeated `volare setup` and `volare config codex` runs converge the Codex config instead of accumulating stale Volare sections or mismatched defaults.
- Users can diagnose Volare-owned Codex config drift without exposing secrets.
- The default Volare Codex profile remains `gpt-5.5` with high reasoning unless the user explicitly configures otherwise.

### Implementation scope

- Make Volare manage only its own Codex provider/profile block with explicit boundaries or equivalent deterministic ownership.
- Clean up known Volare-owned legacy config fragments during repair while preserving unrelated Codex config sections.
- Keep backup files out of the `~/.codex` root when Volare rewrites Codex config.
- Add CLI affordance for safe config diagnosis and repair semantics.

### Validation

- Add/update unit tests for managed config convergence, legacy cleanup, backup placement, CLI parsing, and diagnostic output.
- Run targeted tests for Codex config/CLI.
- Run repository check and full test suite before completion.

### Docs/status

- Update README and Codex integration docs for the new config hygiene workflow.
- Record implementation evidence and completion audit in this goal file.

### Deferred/out of scope

- Do not bump package versions, publish releases, or push branches unless explicitly requested.
- Do not rewrite user-owned Codex sections such as projects, MCP servers, marketplaces, or unrelated providers.
- Do not change Codex Desktop internals or force-map unsupported request models in Volare in this goal.

## Progress log

- Turn 0: Goal registered.
- Turn 1: Implemented bounded Volare-managed Codex config, safe doctor/repair CLI behavior, reasoning-effort propagation, tidy backups with pruning, legacy cleanup, docs, tests, and review-driven protection against unclosed managed block data loss.
- Turn 2: Ran additional review/refinement rounds, added doctor detection for invalid non-Volare TOML that would still be invalid after repair, and verified packaging for the CLI change.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: Repeated `volare setup` and `volare config codex` runs converge the Codex config instead of accumulating stale Volare sections or mismatched defaults. | `scripts/config-codex.ts` now replaces a bounded managed block, updates top-level defaults, removes unmanaged Volare sections, and has idempotency coverage in `tests/unit_tests/scripts/config-codex.test.ts`. | met |
| User-visible behavior: Users can diagnose Volare-owned Codex config drift without exposing secrets. | `volare config codex doctor` is implemented in `src/cli.ts`; tests assert safe issue output, no secret-like values are printed, and invalid TOML that repair cannot fix is reported with a safe issue code. | met |
| User-visible behavior: The default Volare Codex profile remains `gpt-5.5` with high reasoning unless the user explicitly configures otherwise. | `DEFAULT_MODEL` remains `gpt-5.5`, `DEFAULT_REASONING_EFFORT` remains `high`, and `--reasoning-effort <low|medium|high|xhigh>` is propagated through setup/config tests. | met |
| Implementation scope: Make Volare manage only its own Codex provider/profile block with explicit boundaries or equivalent deterministic ownership. | Managed markers `# >>> volare managed` / `# <<< volare managed` wrap only Volare provider/profile sections; unrelated sections are preserved in unit and integration tests. | met |
| Implementation scope: Clean up known Volare-owned legacy config fragments during repair while preserving unrelated Codex config sections. | Legacy `agent-loom` provider/profile cleanup is covered while `[model_providers.other]` remains preserved in tests. | met |
| Implementation scope: Keep backup files out of the `~/.codex` root when Volare rewrites Codex config. | Backups now use `backups/volare/config-<suffix>.toml` next to the selected config, with pruning coverage. | met |
| Implementation scope: Add CLI affordance for safe config diagnosis and repair semantics. | `volare config codex doctor` diagnoses drift; `volare config codex repair` is an explicit configure/repair alias. | met |
| Validation: Add/update unit tests for managed config convergence, legacy cleanup, backup placement, CLI parsing, and diagnostic output. | Updated `tests/unit_tests/scripts/config-codex.test.ts`, `tests/unit_tests/cli.test.ts`, and `tests/integration_tests/codex-cli-provider.test.ts`. | met |
| Validation: Run targeted tests for Codex config/CLI. | `bun test tests/unit_tests/scripts/config-codex.test.ts tests/unit_tests/cli.test.ts` passed. | met |
| Validation: Run repository check and full test suite before completion. | `bun run check`, `bun run test`, and `bun run package` passed. | met |
| Docs/status: Update README and Codex integration docs for the new config hygiene workflow. | Updated `README.md`, `docs/codex-integration.md`, and `docs/configuration.md`. | met |
| Docs/status: Record implementation evidence and completion audit in this goal file. | This completion audit records criterion-to-evidence mapping. | met |
| Deferred/out of scope: Do not bump package versions, publish releases, or push branches unless explicitly requested. | Version files were not changed; no release or push was performed. | met |
| Deferred/out of scope: Do not rewrite user-owned Codex sections such as projects, MCP servers, marketplaces, or unrelated providers. | Tests cover preservation of unrelated provider sections; implementation removes only Volare-owned/current and known Volare legacy sections. | met |
| Deferred/out of scope: Do not change Codex Desktop internals or force-map unsupported request models in Volare in this goal. | No Desktop internals or model force-mapping behavior were changed. | met |

## Deferred items

- None. Use `reason=<out_of_scope|needs_user_decision|future_phase|blocked_by_dependency>` when adding deferred work.

## Blockers

- None.
