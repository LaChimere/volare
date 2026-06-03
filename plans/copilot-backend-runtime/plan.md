# Copilot backend runtime plan

> Purpose: a reviewable plan for executing the ACP probe gate. This plan does not authorize ACP runtime implementation until probe evidence is recorded and the design gate passes. A future ACP implementation plan/todo must be created or updated after a passing gate decision.

## Objective

- Produce trustworthy ACP probe evidence for Copilot CLI before implementing `AcpCopilotPromptRunner`.
- Decide whether ACP is a feasible, valuable runtime path by validating protocol behavior, isolation boundaries, cancellation semantics, and startup ROI.

## Constraints

- Compatibility constraints:
  - Keep `process` mode as the default and do not change runtime behavior in the probe phase.
  - Preserve OpenAI Responses wire compatibility and protocol-neutral core boundaries.
  - Preserve projectless workspace isolation.
- Performance constraints:
  - Measure equivalent milestones before claiming ACP value: process spawn to first stdout, process spawn to first assistant text, ACP cold-worker spawn to first frame/text, and ACP warm-worker prompt to first assistant text.
  - Require at least 5 process samples and 5 ACP warm-worker samples for an ROI decision; if a run produces fewer samples, continue or rerun until the floor is met. Insufficient samples must be recorded as inconclusive and must not proceed to a gate decision without explicit user approval.
  - Gate ROI against the most recent representative historical `backend.turn.completed` p50/p90 evidence from Volare latency logs or `plans/codex-latency-observability`. Fresh synthetic samples characterize startup savings but do not replace the backend-duration denominator. If recent historical backend-duration evidence is unavailable, the ROI gate is inconclusive.
  - Treat ACP as low-priority if startup contribution is below the design threshold.
- Security/safety constraints:
  - Do not log prompts, ACP payload contents, bearer tokens, auth material, or tool data.
  - Do not weaken bearer auth, CORS, bind-host defaults, workspace checks, or local access policy.
  - Do not enable ACP mode with unmediated MCP in the first implementation path.
  - Use the identical minimal synthetic live prompt `Reply with the single word OK.` across discovery and ROI probes unless a specific protocol behavior requires a different prompt structure. Use temporary empty directories created through the OS temp-dir facility as cwd for projectless isolation probes.
- Timeline/rollout constraints:
  - Complete probe gate and update `research.md` / `design.md` before writing any ACP runner implementation plan.
  - Keep probe code testable with fake ACP processes and avoid requiring real Copilot network access in normal tests.
  - Probe-phase changes are limited to `plans/copilot-backend-runtime/**`, `scripts/probe-copilot-cli.ts` or `scripts/probe-copilot-*.ts`, and probe-harness tests. Do not edit production runtime paths such as `src/backends/`, `src/core/`, `src/runtime/server.ts`, or `src/server/config.ts` in this phase.

## Assumptions

- [x] **Verified**: Current Volare backend uses a fresh `copilot --prompt` process per turn.
- [x] **Verified**: Copilot CLI help exposes `--acp`.
- [x] **Verified**: ACP stdio uses newline-delimited JSON-RPC, not Content-Length framing.
- [x] **Verified**: The existing ACP initialize probe in `scripts/probe-copilot-cli.ts` is not trustworthy as written.
- [ ] **Unverified**: Installed Copilot CLI ACP supports `session/new`, `session/prompt`, streamed text updates, and prompt completion with `stopReason`.
- [ ] **Unverified**: Installed Copilot CLI ACP handles `session/cancel` according to spec and drains to `stopReason: "cancelled"`.
- [ ] **Unverified**: Copilot CLI ACP isolates independent protocol sessions sufficiently for Volare projectless/workspace boundaries.
- [ ] **Unverified**: ACP startup/runtime reuse produces material latency benefit on representative Volare turns.

## Options Considered

### Option A: Fix or replace the ACP probe harness first

- Summary: Build a persistent NDJSON JSON-RPC probe harness before any runtime implementation.
- Pros:
  - Directly validates the unknowns that decide whether ACP is viable.
  - Avoids building a runner against wrong protocol assumptions.
  - Keeps runtime behavior unchanged while evidence is gathered.
- Cons:
  - Adds a probe/testing slice before user-visible latency improvement.
- Why chosen:
  - The design gate requires real ACP behavior before implementation planning.

### Option B: Implement ACP runner immediately

- Summary: Start coding `AcpCopilotPromptRunner` from the design without running probes first.
- Pros:
  - Faster to reach a prototype.
- Cons:
  - High risk of implementing the wrong wire protocol, lifecycle, cancellation, or scoping behavior.
  - Could accidentally weaken workspace isolation or create stuck workers.
- Why rejected:
  - Conflicts with the approved design and review findings.

## Proposed Approach (checklist)

- [ ] Step 1: Record design approval and confirm probe-phase scope
  - Acceptance criteria:
    - `design.md` approval is checked with date.
    - Worktree changes are limited to this slug and probe-related files when execution starts.
    - Probe execution follows the probe-phase path allow-list above.
    - No production runtime code is changed before the gate decision.

- [ ] Step 2: Correct or replace the ACP probe harness
  - Acceptance criteria:
    - ACP probes use persistent stdin/stdout pipes.
    - ACP messages are newline-delimited JSON-RPC.
    - `initialize` sends `clientCapabilities`, validates integer `protocolVersion`, and records the full redacted structure of `protocolVersion`, `agentCapabilities`, `agentInfo`, and `authMethods`.
    - Every probe run records `copilot --version` at the start.
    - Probe output uses structured summaries, not raw ACP dumps.
    - Redaction preserves field names and protocol shape while replacing sensitive values with markers such as `<REDACTED:prompt:N_bytes>` or `<REDACTED:token>`.
    - The harness passes synthetic self-tests for valid initialize, malformed JSON, unsupported/non-integer protocol version, stderr capture, and timeout before any live Copilot CLI result is trusted.

- [ ] Step 3: Run real Copilot CLI discovery probes before locking fake fixtures
  - Acceptance criteria:
    - Discovery covers startup/handshake, supported and unsupported `protocolVersion` behavior, `authMethods`, full redacted `agentCapabilities`, `session/new`, and `session/prompt`.
    - If `copilot --version` differs from the version documented in `research.md`, the probe evidence records the new version and explicitly states whether results remain consistent with research assumptions or require design revision.
    - `session/prompt` sends the formatted prompt as `ContentBlock[]` with one text block and records the actual update notification method, text-delta shape, terminal response framing, and observed `stopReason` values.
    - Discovery enumerates every server-to-client request/notification emitted with minimal `clientCapabilities`, including permission, auth, terminal, filesystem, or unknown callbacks.
    - Discovery records binding location and mutability for cwd, model, permission mode, MCP mode, and `--no-custom-instructions`: worker startup flag, `initialize`, `session/new`, later config method, or unsupported.
    - Discovery uses the minimal synthetic prompt and redacted summaries unless a representative prompt is explicitly needed for timing.

- [ ] Step 4: Add fake-ACP tests using observed protocol fixtures
  - Acceptance criteria:
    - Fake-ACP tests use a mock subprocess or fake ACP server with predefined NDJSON JSON-RPC frames; they do not require real Copilot CLI or network access.
    - Tests cover initialize success/failure, missing/non-integer/unsupported protocol versions, `authMethods`, outbound `session/new`, outbound `session/prompt` frame construction with one text `ContentBlock`, observed update notification parsing, terminal response framing, observed `stopReason` parsing, permission request handling, unsupported reverse-client requests, cancellation drain, malformed stdout, stderr diagnostics, unexpected exit, and timeout paths.

- [ ] Step 5: Run full behavioral and ROI probes
  - Acceptance criteria:
    - Probe verifies `session/cancel` drains the original `session/prompt` response with `stopReason: "cancelled"` or records the exact failure mode needed for kill-and-replace planning.
    - Probe checks repeated cancel behavior and confirms canceling an old in-flight prompt cannot kill a replacement worker.
    - Probe checks projectless cwd isolation, distinct cwd filesystem boundaries, conversation-history isolation, permission-state isolation, and state leakage across ACP `sessionId`s.
    - Probe checks same-worker concurrent `session/prompt` calls on distinct `sessionId`s and records whether Copilot CLI interleaves safely, serializes, errors, or leaks state. The first implementation remains one in-flight prompt per worker unless this probe clearly proves safe multiplexing.
    - Probe checks abandoned or stalled in-flight behavior by issuing `session/prompt`, stopping stdout reads after the first delta/frame, then recording whether the worker blocks, errors, buffers, and can recover through subsequent `session/cancel`.
    - Probe induces at least one controlled failure surface, such as invalid auth configuration or offline-equivalent network failure, and records startup/handshake response, stderr summary, process exit behavior, and whether the worker can be removed cleanly.
    - Any behavior that cannot be safely or deterministically proven against live Copilot CLI before a production runner exists must be named explicitly in the gate decision and carried into the ACP implementation plan as a required fake-ACP or integration test.
    - Probe captures process spawn to first stdout, process spawn to first assistant text, ACP cold-worker spawn to first frame/text, and ACP warm-worker prompt to first assistant text.
    - ROI uses at least 5 process samples, 5 ACP warm-worker samples, and 3 ACP cold-worker samples. Cold-worker timings are informational for first-turn/eager-initialization planning unless a later design explicitly makes them gate-level evidence.
    - ROI reports p50, p90, max, sample count, prompt/cwd profile, historical backend-duration denominator source, and fresh synthetic timing samples.
    - ROI compares estimated continuation-turn savings (`process spawn->first assistant text` minus `ACP warm prompt->first assistant text`) against the pinned historical p50 backend duration. If savings are below 5% of p50 backend duration, ACP is not the next latency-first implementation path.

- [ ] Step 6: Update slug artifacts with evidence and gate decision
  - Acceptance criteria:
    - `research.md` includes probe commands, environment, summarized outputs, timing method, and conclusion.
    - `research.md` includes an "Observed ACP protocol fixtures" section containing the Copilot CLI version, negotiated `protocolVersion`, redacted `agentCapabilities`, `authMethods`, update notification method, terminal response framing, observed `stopReason` values, reverse-callback methods, multiplexing behavior, and cwd/model/permission/MCP/no-custom-instructions binding matrix.
    - `design.md` is updated if probe results change runtime scope, worker scoping, cancellation handling, or feasibility.
    - `todo.md` evidence log records commands and concise evidence.
    - Gate decision follows the outcome table below.

### Gate outcome table

| Probe outcome | Action |
|---|---|
| Transport, prompt, completion, permission/auth handling, isolation, cancellation, and ROI all pass | Proceed to a future ACP runner implementation plan/todo. |
| ACP transport, prompt, completion framing, required permission/auth handling, or state isolation fails | Do not implement ACP runtime in this slug; update design with the blocker and choose a different latency path. |
| Cancellation is unsupported or unreliable but prompt framing and isolation pass | Plan ACP only if kill-and-replace preserves current cancel semantics and the implementation plan includes explicit tests; otherwise revise design. |
| Cancellation improves but ROI is below threshold | Record the correctness trade-off and defer ACP to a future correctness-focused slug; do not treat it as this latency slug's next implementation path. |
| Multiplexing is unsafe or unproven while isolation otherwise passes | Future ACP implementation plan must lock one in-flight prompt per worker and cite the observed protocol fixture evidence. |
| ROI is below threshold with sufficient samples | Do not build ACP as a latency-first optimization; prioritize concurrency/admission, prompt/history, or provider-latency work. |
| ROI sample size or backend-duration denominator is insufficient | Record the gate as inconclusive and rerun probes or gather historical latency evidence before deciding. |

## Post-gate ACP implementation plan

Gate decision: proceed with ACP implementation planning under the cancellation-unreliable outcome row. Runtime code changes are now allowed only within the slices below, and `process` mode remains default until the implementation and integrated-runner ROI checks pass.

- [ ] Step 7: Add runtime config and validation
  - Acceptance criteria:
    - Add `VOLARE_COPILOT_RUNTIME_MODE=process|acp`, default `process`.
    - Add `VOLARE_COPILOT_ACP_MAX_WORKERS`, default `10`, effective cap no greater than `VOLARE_MAX_ACTIVE_SESSIONS`.
    - Reject `VOLARE_COPILOT_RUNTIME_MODE=acp` with `VOLARE_COPILOT_MCP_MODE=unmediated`.
    - Log selected runtime mode at startup.
    - Tests cover defaults, invalid values, cap bounds, and unmediated-MCP rejection.

- [ ] Step 8: Move ACP JSON-RPC protocol handling into production backend code
  - Acceptance criteria:
    - Production peer uses persistent NDJSON JSON-RPC with stdout-only frames and stderr diagnostics.
    - `initialize` uses `clientCapabilities`, validates returned integer `protocolVersion`, records/handles `authMethods`, and rejects unsupported returned versions.
    - `session/new` response shape is validated; null/non-object/missing `sessionId` fail explicitly.
    - Permission reverse requests are handled by explicit policy; unsupported callbacks receive explicit JSON-RPC errors.
    - Fake-ACP tests cover malformed stdout, unsupported returned versions, null `session/new`, auth-required/error responses, permission allow/deny/cancelled, stderr capture, unexpected exit, and timeout.

- [ ] Step 9: Implement `AcpCopilotPromptRunner`
  - Acceptance criteria:
    - Runner implements `ICopilotPromptRunner` without core protocol changes.
    - Prompt is sent as one text `ContentBlock[]` preserving existing `formatCopilotPrompt()` behavior.
    - One in-flight prompt per worker is enforced even though the probe saw same-worker concurrent prompts fulfill.
    - Worker/session scope includes cwd/backend session, permission mode, MCP mode, model/config options as observed.
    - Worker cap exhaustion fails explicitly; no silent fallback to process mode.
    - Process mode remains behavior-compatible with existing tests.

- [ ] Step 10: Implement kill-and-replace cancellation and lifecycle bounds
  - Acceptance criteria:
    - `cancel()` preserves existing return semantics: no active turn returns `not_found`.
    - In-flight ACP cancellation marks only the owning worker for replacement; stale/repeated cancels cannot kill a replacement worker.
    - `session/cancel` may be attempted, but because native drain-to-`cancelled` was not proven, timeout falls back to killing/replacing the owning worker.
    - Tests cover repeated cancel, stale cancel after replacement, sibling worker survival, disconnect cleanup, startup/handshake timeout, active-turn no-progress timeout, idle eviction, replacement backoff, and shutdown with in-flight turns.

- [ ] Step 11: Add observability, docs, and integrated ROI verification
  - Acceptance criteria:
    - Structured logs include selected runtime mode, worker startup/handshake/session creation, first frame, first assistant text, prompt duration, stop reason, cancellation path, replacement reason, active worker count, and cap exhaustion.
    - `docs/configuration.md` and `docs/operations.md` document ACP opt-in, rollback to process mode, unmediated MCP incompatibility, and troubleshooting.
    - Integrated runner ROI is remeasured with at least the probe sample floors before claiming improvement.
    - If integrated ROI regresses below threshold, ACP remains experimental/opt-in and the result is recorded.

## Touch Surface

- Key files/modules likely to change:
  - `scripts/probe-copilot-cli.ts` or a focused `scripts/probe-copilot-acp.ts`
  - tests under `tests/unit_tests/` and/or `tests/integration_tests/` for the probe harness
  - `src/backends/copilot-cli/` for post-gate ACP protocol/runner implementation
  - `src/server/config.ts` for post-gate runtime config
  - `src/runtime/server.ts` for post-gate runner selection
  - `docs/configuration.md` and `docs/operations.md` for post-gate opt-in documentation
  - `plans/copilot-backend-runtime/research.md`
  - `plans/copilot-backend-runtime/design.md`
  - `plans/copilot-backend-runtime/todo.md`
- Public API / schema impacts:
  - None in the probe phase.
- Data impacts:
  - None.

## Verification Plan (Done = Evidence)

### Target verification level

- [ ] L1
- [x] L2
- [ ] L3

### Evidence to produce

- [ ] Tests to run:
  - `bun run check`
  - `bun run test`
  - targeted Bun tests for any new probe harness units
- [ ] Before/after behavior proof:
  - Process mode remains default and unchanged.
  - Probe gate output documents whether ACP can safely carry Volare turns.
- [ ] Logs/traces/metrics to capture:
  - Probe startup/handshake/session/prompt/cancel timings.
  - Redacted ACP capability, observed protocol fixture, binding matrix, and callback-method summary.
  - ROI comparison method and result.

## Rollback / Recovery

- Rollback plan:
  - Revert probe-script and test changes; runtime behavior remains `process` mode.
  - If ACP probes fail, update the design with blockers and stop before runtime implementation.
- Data safety notes:
  - No migrations or state changes.
- Feature flag / config toggles:
  - No runtime toggle is introduced in the probe phase.
  - Future ACP implementation remains behind `VOLARE_COPILOT_RUNTIME_MODE=acp`.

## Risks / Non-goals

- Risks:
  - Real Copilot CLI ACP behavior may differ from public ACP docs.
  - Live prompt probes may contact the model; they must be explicit, minimal, and redacted.
  - Low startup ROI may make ACP the wrong next latency investment.
  - Projectless workspace isolation may reduce worker reuse, which is acceptable.
- Explicit non-goals:
  - No ACP runner implementation in the probe phase.
  - No RAG, source grounding, source references, or tool provenance changes.
  - No terminal/filesystem ACP client capability in the first runner path.
  - No changes to OpenAI Responses wire shape.

## Review Notes / Annotations

Design was approved by the user on 2026-05-20. This plan is for the probe gate only; implementation planning requires probe evidence and a passing gate decision.

## Approval

- [ ] Plan approved by:
- Date:
