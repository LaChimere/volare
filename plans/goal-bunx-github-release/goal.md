# Goal State

objective: "那我们就支持 bunx（先不管 npx）。版本发布需要通过 github 的 workflow 来做，而不是我们自己手动发布。我觉得你可以加一下 PR gate （测试、验证等）的 workflow 以及发 release 和 bunx 相关的 workflows"
status: complete
slug: "goal-bunx-github-release"
turns_used: 2
turn_budget: null
docs_update_approved: true
created_at: "2026-05-04T15:58:44+08:00"
updated_at: "2026-05-04T16:08:52+08:00"

## Acceptance criteria

### User-visible behavior

- Published package metadata and docs support `bunx agent-loom <command>` as the intended CLI usage.
- Pull requests and main pushes are validated by GitHub Actions.
- Releases are published through GitHub Actions rather than manual local publishing.

### Implementation scope

- Update npm package metadata, published file allowlist, CLI executable bit, and documentation for bunx usage.
- Add GitHub Actions workflows for CI/PR gate validation and release publishing.
- Keep npx out of scope for this iteration.

### Validation

- Run local package dry-run and bunx/tarball smoke validation where possible.
- Run `bun run check`, `bun run test`, and `bun run package`.
- Review the workflow/package changes before committing.

### Docs/status

- Update docs/README content that describes CLI installation, bunx usage, and release requirements.
- Keep this goal state updated with decisions, validation, deferred items, and completion audit.

### Deferred/out of scope

- npx support without requiring Bun is out of scope.
- Manual npm publishing from a developer machine is out of scope.
- Cross-platform standalone binary release artifacts are out of scope.

## Progress log

- Turn 0: Goal registered.
- Turn 1: Prepared package metadata and bunx-facing docs, made `src/cli.ts` executable, narrowed published files to runtime sources plus `scripts/config-codex.ts`, and removed the install-time `postinstall` hook so published CLI installs have no side effects.
- Turn 2: Added `.github/workflows/ci.yml` for PR/main validation and `.github/workflows/release.yml` for GitHub Release-driven npm trusted publishing with provenance. Local pack smoke showed direct `bunx ./tarball.tgz` is not supported, so workflows install the packed tarball into a temporary directory and run `bunx --bun agent-loom help`.

## Deferred items

- Node-only `npx` support remains out of scope; reason=out_of_scope.
- Manual npm publishing from developer machines remains out of scope; reason=out_of_scope.
- Cross-platform standalone binary release artifacts remain out of scope; reason=future_phase.
- npm trusted publishing must be configured in npm for this repository/workflow before the first real release; reason=blocked_by_dependency.

## Blockers

- None.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: Published package metadata and docs support `bunx agent-loom <command>` as the intended CLI usage. | `package.json` now includes package metadata, `bin`, executable `src/cli.ts`, narrowed `files`, and Bun engine; `README.md` documents `bunx agent-loom ...`. | met |
| User-visible behavior: Pull requests and main pushes are validated by GitHub Actions. | `.github/workflows/ci.yml` runs Bun install/check/test/package, npm pack dry-run, and bunx smoke on pull requests and `main` pushes. | met |
| User-visible behavior: Releases are published through GitHub Actions rather than manual local publishing. | `.github/workflows/release.yml` publishes from GitHub Release tags or manual workflow dispatch using npm provenance/trusted publishing. | met |
| Implementation scope: Update npm package metadata, published file allowlist, CLI executable bit, and documentation for bunx usage. | Updated `package.json`, `README.md`, `docs/development.md`; `src/cli.ts` mode is executable and pack dry-run shows mode `493`. | met |
| Implementation scope: Add GitHub Actions workflows for CI/PR gate validation and release publishing. | Added `.github/workflows/ci.yml` and `.github/workflows/release.yml`. | met |
| Implementation scope: Keep npx out of scope for this iteration. | Docs explicitly state Node-only `npx` execution is not targeted in this release track. | met |
| Validation: Run local package dry-run and bunx/tarball smoke validation where possible. | `npm pack --dry-run --json` and local tarball install plus `bunx --bun agent-loom help` passed. | met |
| Validation: Run `bun run check`, `bun run test`, and `bun run package`. | `bun run check && bun run test && bun run package` passed. | met |
| Validation: Review the workflow/package changes before committing. | `release-workflow-review` found and fixed the NODE_AUTH_TOKEN/OIDC conflict; `final-release-review` found no significant issues. | met |
| Docs/status: Update docs/README content that describes CLI installation, bunx usage, and release requirements. | `README.md` documents bunx usage; `docs/development.md` documents CI/release automation and trusted publishing setup. | met |
| Docs/status: Keep this goal state updated with decisions, validation, deferred items, and completion audit. | This file records decisions, deferred items, and this completion audit. | met |
| Deferred/out of scope: npx support without requiring Bun is out of scope. | Not implemented; documented as out of scope. | met |
| Deferred/out of scope: Manual npm publishing from a developer machine is out of scope. | Release workflow publishes through GitHub; no manual publish instructions were added. | met |
| Deferred/out of scope: Cross-platform standalone binary release artifacts are out of scope. | Workflow validates `bun run package` but does not attach standalone binary artifacts. | met |
