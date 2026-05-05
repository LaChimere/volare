# Development

Volare is a Bun/TypeScript project. Use Bun for dependency management, scripts, tests, and packaging.

## Repository layout

```text
src/
  approvals/                  approval policy/provider
  backends/copilot-cli/        Copilot CLI backend process integration
  core/                        protocol-neutral runtime types and session logic
  events/                      journal persistence and redaction
  logging/                     structured logger abstraction
  northbound/openai-responses/ OpenAI Responses/Codex adapter
  runtime/                     production runtime wiring
  server/                      HTTP app, auth, config, shutdown
  state/                       SQLite migrations and state store
scripts/                      local helper scripts
tests/                        unit and integration tests plus test-only helpers
docs/                         project documentation
```

## Commands

```bash
bun install
bun run hooks:install
bun run check
bun run test
bun run package
```

`bun run check` runs Biome and TypeScript. `bun run test` runs unit and integration tests. `bun run package` compiles `src/cli.ts` to `builds/volare`.
Hook installation is explicit so the published CLI package has no install-time side effects.

## PR and release automation

Pull requests and pushes to `main` run the CI workflow in `.github/workflows/ci.yml`. The gate installs dependencies with Bun, runs `bun run check`, `bun run test`, `bun run package`, performs `npm pack --dry-run`, and smoke-tests the packed CLI with `bunx`.

Releases publish `@lachimere/volare` through `.github/workflows/release.yml`, not from a developer machine. Publish a GitHub Release whose tag matches the package version, for example `vX.Y.Z`; the workflow verifies the tag, reruns validation, smoke-tests the packed CLI with `bunx`, and publishes to npm with provenance. Configure npm trusted publishing for the `npm` environment before workflow-driven publishing. If npm OIDC cannot create a brand-new package, a maintainer may need a one-time bootstrap publish; after the package exists, subsequent releases should go through the workflow. The workflow also supports a manual dry run through `workflow_dispatch` and skips npm publish when the exact package version already exists. After publishing, `bunx @lachimere/volare update` refreshes Bun's bunx cache for local users.

## Naming and type boundaries

- Interfaces use an `I` prefix, for example `IStateStore`.
- Concrete classes and functions do not use the `I` prefix.
- Core runtime types must stay protocol-neutral.
- OpenAI Responses-specific IDs, request parsing, response wire shapes, and Codex model catalog behavior belong in `src/northbound/openai-responses/`.

## Error handling

Prefer explicit, typed errors using `VolareError` or `toVolareError`. Do not add broad catch blocks that silently return success-shaped values. Cleanup failures should not mask original errors; log cleanup failures and preserve the root cause where possible.

## Logging

Use the `ILogger` abstraction and structured fields. Avoid ad hoc `console` output in runtime code. CLI/user-facing output is the exception.

## Testing guidance

Add targeted unit tests for behavior changes. Important coverage areas include:

- OpenAI Responses parsing and SSE encoding.
- Durable session state transitions and cancellation.
- Workspace resolution and projectless isolation.
- Copilot CLI backend prompt framing, output parsing, cancellation, and process identity checks.
- SQLite state and journal error handling.
- CLI parsing, daemon lifecycle, and Codex config generation.

Run the narrow test first while iterating, then run `bun run check` and `bun run test` before committing. Run `bun run package` when CLI or packaging behavior changes.

## Documentation updates

Update `docs/` when changing:

- Runtime architecture or component ownership.
- Configuration variables or CLI flags.
- Codex/OpenAI Responses compatibility.
- Operational workflows, logs, metrics, or troubleshooting.
- Development conventions.

Keep `README.md` short and link to the detailed docs rather than duplicating them.
Planning and goal artifacts are temporary execution records. Promote durable design decisions into `docs/` before cleaning those artifacts up.
