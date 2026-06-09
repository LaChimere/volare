# Testing

Volare's test suite is being migrated from the legacy `tests/unit_tests` / `tests/integration_tests` layout to a layered, contract-driven layout. The migration is coverage-preserving: legacy tests remain active until their parity ledger entries prove that target tests preserve, broaden, or intentionally retire the old assertions.

## Current commands

These commands exist today:

```bash
bun run check
bun run test:unit
bun run test:unit:target
bun run test:component
bun run test:integration
bun run test:integration:http
bun run test:integration:backend
bun run test:integration:durable
bun run test:integration:mock
bun run test:e2e:codex
bun run test:contract
bun run test:security
bun run test
bun run ci
```

- `bun run check` runs Biome and TypeScript.
- `bun run test:unit` runs the populated target unit tests.
- `bun run test:unit:target` runs the populated `tests/unit/**/*.test.ts` files and fails if the target lane is empty.
- `bun run test:component` runs the populated `tests/component/**/*.test.ts` files and fails if the target lane is empty.
- `bun run test:integration` runs `bun test tests/integration_tests --timeout=30000 --pass-with-no-tests`.
- `bun run test:integration:http` runs the populated `tests/integration/http/**/*.test.ts` files and fails if the target lane is empty.
- `bun run test:integration:backend` runs the populated `tests/integration/backend/**/*.test.ts` files and fails if the target lane is empty.
- `bun run test:integration:durable` runs the populated `tests/integration/durable/**/*.test.ts` files and fails if the target lane is empty.
- `bun run test:integration:mock` aliases `test:integration:http` while the migration still uses the mock lane name.
- `bun run test:e2e:codex` runs the current real Codex CLI E2E file and fails if that file path drifts.
- `bun run test:contract` runs the populated `tests/contract/**/*.test.ts` files and fails if the target lane is empty.
- `bun run test:security` runs the populated `tests/security/**/*.test.ts` files and fails if the target lane is empty.
- `bun run test` runs the current unit, component, legacy integration, populated target integration, contract, and security scripts.
- `bun run ci` runs Biome, TypeScript, unit tests, component tests, legacy integration tests, populated target integration tests, contract tests, and security tests.

Target lane names such as `test:package-smoke` are planned migration outputs. Do not document or use them as existing commands until their package scripts land.

## Target layout

```text
tests/
  unit/
  component/
  integration/
    http/
    durable/
    backend/
  e2e/
    codex/
  contract/
    openai/
    journal/
    capabilities/
  security/
  support/
  fixtures/
```

Layer ownership:

| Layer | Owns |
|---|---|
| `unit` | Pure local decisions and invariants. |
| `component` | Protocol-neutral seams across multiple modules without real sockets, real processes, or file-backed durable state unless that is the seam under test. |
| `integration/http` | `createApp`, routes, auth, status, headers, SSE setup, and error-envelope behavior. |
| `integration/durable` | File-backed SQLite, restart, migration, recovery, and replay behavior. |
| `integration/backend` | ACP JSON-RPC peer behavior, fake process / ACP runner behavior, and process lifecycle behavior. |
| `e2e/codex` | Real Codex/client interoperability. |
| `contract` | Stable wire, schema, and replay artifacts with dynamic data normalized. |
| `security` | Sentinel-based no-leak assertions across public/debug/log/metric surfaces and subprocess environment handling. |

## Migration rules

- Keep the migration parity ledger current before deleting or disabling any legacy test.
- A legacy test file can be removed only when every ledger entry for that file is `rewritten`, `split`, or `retired`.
- During migration, aggregate `test` and `ci` scripts must run all still-active legacy lanes plus any populated target lanes.
- Do not use `--pass-with-no-tests` for explicit populated target scripts; a wrong target path should fail loudly.
- Move one legacy file or one tightly related split group per PR.
- If legacy and target tests disagree before a ledger entry is terminal, legacy behavior remains the baseline unless the PR explicitly documents an intentional behavior correction.
- Temporary legacy bridge files may import moved target tests while a mixed legacy file is being split across layers. They intentionally duplicate execution across legacy and target lanes until the corresponding ledger entries are terminal.

## Fixture and golden rules

- Golden tests lock stable external wire/schema/replay artifacts only.
- Normalize ids, timestamps, durations, temporary paths, platform separators, and secrets before comparing golden output.
- Do not snapshot raw secrets, raw ACP payloads with sensitive data, local private paths, or unredacted subprocess environments.
- Security tests should seed fake sentinel values and assert those exact sentinels do not leak. Avoid broad regex scans over arbitrary local output unless the regex belongs to an existing redaction boundary with false-positive coverage.

## Support helper rules

Create support helpers only with concrete consumers. A helper should have at least two existing consumers, or one accepted migration slice / imminent feature with clear acceptance criteria. The first extraction should be mechanical and preserve behavior.

Initial helper candidates are:

- `tests/support/app-harness.ts`
- `tests/support/sse.ts`
- `tests/support/durable-harness.ts`
- `tests/support/assertions.ts`
- `tests/support/security-assertions.ts`

Deferred helpers such as `fake-backends`, `fake-acp-process`, and `snapshots` should land only when target tests need them.
