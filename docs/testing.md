# Testing

Volare's test suite is organized by runtime boundary and verification level. Use the narrowest lane that covers your change while iterating, then run the aggregate validation before committing.

## Commands

```bash
bun run check
bun run test:unit
bun run test:component
bun run test:integration
bun run test:integration:http
bun run test:integration:backend
bun run test:integration:durable
bun run test:e2e:codex
bun run test:contract
bun run test:security
bun run test:package-smoke
bun run test
bun run ci
```

- `bun run check` runs Biome and TypeScript.
- `bun run test:unit` runs `tests/unit/**/*.test.ts`.
- `bun run test:component` runs `tests/component/**/*.test.ts`.
- `bun run test:integration` runs the HTTP, backend, and durable integration lanes.
- `bun run test:integration:http` runs `tests/integration/http/**/*.test.ts`.
- `bun run test:integration:backend` runs `tests/integration/backend/**/*.test.ts`.
- `bun run test:integration:durable` runs `tests/integration/durable/**/*.test.ts`.
- `bun run test:e2e:codex` runs the real Codex CLI E2E lane.
- `bun run test:contract` runs `tests/contract/**/*.test.ts`.
- `bun run test:security` runs `tests/security/**/*.test.ts`.
- `bun run test:package-smoke` verifies the compiled binary, npm pack dry-run, packed tarball install, and `bunx --bun volare help`, then removes generated package artifacts.
- `bun run test` runs unit, component, integration, contract, and security lanes.
- `bun run ci` runs Biome, TypeScript, unit, component, integration, contract, and security lanes.

All populated lane scripts fail loudly when their test path is missing or empty. Do not add `--pass-with-no-tests` to test lanes.

## Layout

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
    capabilities/
    openai/
    journal/
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

## Fixture and golden rules

- Golden tests lock stable external wire/schema/replay artifacts only.
- Normalize ids, timestamps, durations, temporary paths, platform separators, and secrets before comparing golden output.
- Do not snapshot raw secrets, raw ACP payloads with sensitive data, local private paths, or unredacted subprocess environments.
- Security tests should seed fake sentinel values and assert those exact sentinels do not leak. Avoid broad regex scans over arbitrary local output unless the regex belongs to an existing redaction boundary with false-positive coverage.

## Support helper rules

Create support helpers only with concrete consumers. A helper should have at least two existing consumers, or one accepted feature with clear acceptance criteria. The first extraction should be mechanical and preserve behavior.

Current shared helpers include:

- `tests/support/app-harness.ts`
- `tests/support/backends/copilot-cli-backend-harness.ts`
- `tests/support/backends/mock-backend.ts`
- `tests/support/copilot-frame-fixtures.ts`
