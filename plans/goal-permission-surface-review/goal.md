# Goal State

objective: "可以看一下权限这边除了 url，别的是否也有类似的问题。可以多 review 和 refine 几轮"
status: complete
slug: "goal-permission-surface-review"
turns_used: 3
turn_budget: null
docs_update_approved: false
created_at: "2026-05-04T00:36:24.067+08:00"
updated_at: "2026-05-04T00:52:00+08:00"

## Acceptance criteria

### User-visible behavior

- Agent Loom's permission behavior should be predictable across Copilot CLI URL, shell/tool, file path, and MCP/tool surfaces.
- Default behavior should support common research prompts without misleading permission-denied claims, while not silently granting broad filesystem or shell access.
- Trusted users should have an explicit way to opt into broader Copilot CLI permissions when they want Codex/Desktop "Full access"-like behavior through the Copilot CLI subprocess.

### Implementation scope

- Review Copilot CLI permission surfaces and Agent Loom's mapping for URL, tools/shell, paths, built-in MCP, and tool availability.
- Refine code/config/tests/docs if the current `restricted`/`web`/`full` model leaves avoidable misleading permission gaps.
- Preserve bearer auth, workspace isolation, and production/test boundaries.

### Validation

- Use direct Copilot CLI experiments to verify permission-mode behavior beyond URL fetches.
- Run targeted tests for changed backend/config behavior.
- Run repository checks/tests/package for touched surfaces.
- Run Codex CLI through Agent Loom after fixes with prompts that exercise web and shell/file-like behavior, checking for inaccurate permission-denied claims.

### Docs/status

- Record research findings, design choices, and validation evidence in this goal state.
- Update directly related docs if permission semantics change.

### Deferred/out of scope

- A full OpenAI Responses client tool-call broker may remain deferred with reason=future_phase if not required to make current Copilot CLI subprocess permissions coherent.

## Progress log

- Turn 0: Goal registered.
- Turn 1: Reviewed Copilot CLI permission surfaces beyond URL: URL grants, shell/tool grants, path grants, deny/allow URL/tool filters, built-in MCP controls, and non-interactive authorization behavior.
- Turn 2: Ran direct Copilot CLI experiments across `restricted`, `web`, and `full`. Confirmed `web` solves public URL fetches but can still deny shell/CLI tools; `full` allows both shell and URL access; file reads inside the backend cwd are available in the tested modes.
- Turn 3: Refined Agent Loom ergonomics by adding `agent-loom start --copilot-permission-mode <restricted|web|full>`, updating docs, adding CLI tests, adding explicit `web` mode test coverage after code review, and validating through Codex CLI with daemon mode `full`.

## Deferred items

- Full OpenAI Responses client tool-call broker. reason=future_phase. The current work makes Copilot CLI subprocess permissions explicit and testable; it still does not dynamically forward Codex UI/Desktop permission state or execute Codex client tools.

## Blockers

- None.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: predictable permission behavior across URL, shell/tool, file path, and MCP/tool surfaces | Direct Copilot CLI review identified the relevant permission flags; Agent Loom now documents and exposes `restricted`, `web`, and `full` modes. | met |
| User-visible behavior: common research prompts work without misleading permission-denied claims while avoiding broad default grants | Existing default `web` mode remains URL-only for public fetches; docs clarify that `full` is explicit opt-in for shell/tool/path grants. | met |
| User-visible behavior: trusted users can opt into broader Full-access-like behavior | `src/cli.ts` supports `start --copilot-permission-mode full`; runtime config already maps `full` to Copilot CLI `--allow-all`. | met |
| Implementation scope: review URL, tools/shell, paths, built-in MCP, and tool availability | Reviewed `copilot --help` permission surfaces and ran direct CLI experiments for URL, shell, and file/cwd behavior; docs retain the built-in MCP limitation from `--disable-builtin-mcps`. | met |
| Implementation scope: refine code/config/tests/docs if needed | Updated `src/cli.ts`, `tests/unit_tests/cli.test.ts`, `tests/unit_tests/backends/copilot-cli-backend.test.ts`, `docs/configuration.md`, and `docs/codex-integration.md`. | met |
| Implementation scope: preserve auth/workspace/test boundaries | Changes only add CLI env wiring, tests, and docs; server auth/workspace isolation logic is unchanged. | met |
| Validation: direct Copilot CLI experiments beyond URL | Tested `restricted`, `web`, and `full`; observed shell denial in `web` for tool-heavy shell checks and successful shell+URL behavior in `full`. | met |
| Validation: targeted tests | `bun test tests/unit_tests/cli.test.ts tests/unit_tests/backends/copilot-cli-backend.test.ts tests/unit_tests/server/app.test.ts` passed; after review fix, `bun test tests/unit_tests/backends/copilot-cli-backend.test.ts tests/unit_tests/cli.test.ts && bun run check` passed. | met |
| Validation: repository checks/tests/package | `bun run check`, `bun run test`, and `bun run package` passed after the final changes. | met |
| Validation: Codex CLI through Agent Loom | Restarted daemon with `--copilot-permission-mode full`; Codex CLI prompt requiring shell `printf shell-ok` and `https://example.com` fetch returned `shell=shell-ok` and web content with no real permission-denied marker. | met |
| Docs/status: record findings and evidence | This goal state records findings, implementation, validation, and deferred broker work. | met |
| Docs/status: update directly related docs | `docs/configuration.md` lists env and CLI flag; `docs/codex-integration.md` explains `restricted`, `web`, `full`, and why Codex UI Full access does not auto-forward. | met |
| Deferred/out of scope: full tool-call broker may remain deferred | Deferred item records bridge-owned tool-call broker as reason=future_phase. | met |
