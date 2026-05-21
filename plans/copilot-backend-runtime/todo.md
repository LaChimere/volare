# Copilot backend runtime task checklist

> Purpose: execution-phase checklist for the ACP probe gate. This is not the ACP runtime implementation checklist.

## Task

- Summary: Correct/replace the ACP probe harness, run the pre-plan probe gate, and update slug artifacts with evidence before ACP runner implementation planning.
- Links:
  - `plans/copilot-backend-runtime/research.md`
  - `plans/copilot-backend-runtime/design.md`
  - `plans/copilot-backend-runtime/plan.md`

## Plan Reference

- Plan version/date: 2026-05-20
- Approved by (if applicable): design approved by user; plan approval pending

## Checklist

### Preparation

- [ ] Confirm worktree scope before execution
  - Acceptance criteria:
    - Only intended slug/probe changes are present before edits.
    - Probe-phase edits stay within `plans/copilot-backend-runtime/**`, `scripts/probe-copilot-cli.ts` or `scripts/probe-copilot-*.ts`, and probe-harness tests.
    - No production runtime paths under `src/backends/`, `src/core/`, `src/runtime/server.ts`, or `src/server/config.ts` change before the gate decision.
  - Evidence:
- [ ] Confirm verification level target
  - Acceptance criteria: L2 verification is used for probe harness changes.
  - Evidence:
- [ ] Confirm existing ACP probe limitations
  - Acceptance criteria: current one-shot Content-Length-style initialize probe is not used as gate evidence.
  - Evidence:

### Implementation

- [ ] Fix or replace ACP probe harness
  - Acceptance criteria:
    - Uses persistent stdin/stdout pipes.
    - Uses NDJSON JSON-RPC framing.
    - Sends `clientCapabilities` in `initialize`.
    - Validates missing, non-integer, and unsupported `protocolVersion` responses.
    - Records `copilot --version` at probe start.
    - Records full redacted structure for `protocolVersion`, `agentCapabilities`, `agentInfo`, and `authMethods`.
    - Emits structured summaries instead of raw ACP payload dumps.
    - Redacts prompts, tokens, ACP payload contents, and sensitive stderr while preserving field names and protocol shape.
    - Passes synthetic self-tests for valid initialize, malformed JSON, unsupported/non-integer protocol version, stderr capture, and timeout before live Copilot CLI evidence is trusted.
  - Evidence:

- [ ] Run real Copilot CLI discovery probes
  - Acceptance criteria:
    - Covers startup/handshake, supported and unsupported `protocolVersion` behavior, `authMethods`, full redacted `agentCapabilities`, `session/new`, `session/prompt`, actual update method name, text-delta shape, and observed `stopReason` values.
    - If `copilot --version` differs from the version documented in `research.md`, records the new version and explicitly states whether results remain consistent with research assumptions or require design revision.
    - Verifies outbound `session/prompt` uses `ContentBlock[]` with one text block.
    - Verifies `stopReason` arrives on the terminal response to the original `session/prompt` request, not only as an update field.
    - Enumerates all server-to-client requests/notifications emitted with minimal `clientCapabilities`, including permission, auth, terminal, filesystem, and unknown callback methods.
    - Records binding location and mutability for cwd, model, permission mode, MCP mode, and `--no-custom-instructions`: worker startup flag, `initialize`, `session/new`, later config method, or unsupported.
    - Uses the identical minimal synthetic live prompt `Reply with the single word OK.` and temporary empty cwd directories unless a representative prompt is explicitly justified and redacted.
    - Explicitly reports unsupported or missing methods.
  - Evidence:

- [ ] Add fake-ACP protocol tests using observed fixtures
  - Acceptance criteria:
    - Uses a mock subprocess or fake ACP server with predefined NDJSON JSON-RPC frames.
    - Does not require real Copilot CLI or network access.
    - Covers initialize success/failure, missing/non-integer/unsupported protocol versions, `authMethods`, outbound `session/new`, outbound `session/prompt` frame construction with one text `ContentBlock`, observed update parsing, terminal response framing, observed `stopReason` parsing, permission request handling, unsupported reverse-client requests, cancellation drain, malformed stdout, stderr diagnostics, unexpected exit, and timeouts.
  - Evidence:

- [ ] Run full behavioral ACP probe cases
  - Acceptance criteria:
    - Verifies `session/cancel` drains the original `session/prompt` response with `stopReason: "cancelled"` or records the exact failure mode needed for kill-and-replace planning.
    - Verifies repeated cancel behavior and confirms an old cancel cannot kill a replacement worker.
    - Tests projectless cwd isolation, distinct cwd filesystem boundaries, conversation-history isolation, permission-state isolation, and state leakage across ACP `sessionId`s.
    - Sends two concurrent `session/prompt` requests on distinct `sessionId`s in one worker and records whether responses interleave safely, serialize, error, or leak state.
    - Tests abandoned or stalled in-flight behavior by issuing `session/prompt`, stopping stdout reads after the first delta/frame, then recording whether the worker blocks, errors, buffers, and can recover through subsequent `session/cancel`.
    - Induces at least one controlled auth/token/network/provider failure surface, then records startup/handshake response, stderr summary, process exit behavior, and clean worker removal behavior.
  - Evidence:

- [ ] Add ROI timing capture
  - Acceptance criteria:
    - Uses the pinned historical p50/p90 `backend.turn.completed` denominator from recent Volare latency evidence or records the gate as inconclusive if that evidence is unavailable.
    - Measures process spawn to first stdout.
    - Measures process spawn to first assistant text.
    - Measures ACP cold-worker spawn to first frame/text.
    - Measures ACP warm-worker prompt to first assistant text.
    - Uses at least 5 process samples, 5 ACP warm-worker samples, and 3 ACP cold-worker samples before making an ROI decision.
    - If a run produces fewer samples due to probe failure, records the result as inconclusive and continues or reruns until the sample floor is met.
    - Reports p50, p90, max, sample count, prompt/cwd profile, historical backend-duration denominator source, and fresh synthetic timing samples.
    - Compares estimated continuation-turn savings against p50 backend duration and the 5% threshold.
  - Evidence:

- [ ] Run and record probe gate
  - Acceptance criteria:
    - Probe commands, environment, redacted output summary, timings, and gate decision are recorded in `research.md`.
    - `research.md` includes an "Observed ACP protocol fixtures" section with Copilot CLI version, negotiated `protocolVersion`, redacted `agentCapabilities`, `authMethods`, update notification method, terminal response framing, observed `stopReason` values, reverse-callback methods, multiplexing behavior, and cwd/model/permission/MCP/no-custom-instructions binding matrix.
    - `design.md` is updated if probe results change assumptions.
    - `todo.md` Evidence Log is updated with exact commands and concise outcomes.
    - Gate decision follows the outcome table in `plan.md`.
  - Evidence:

### Acceptance Gate (before proposing ACP implementation)

- [ ] All probe-gate acceptance criteria above are met with evidence
- [ ] Diff is consistent with approved probe plan
- [ ] Applicable verification level executed
- [ ] `research.md` and `design.md` reflect actual probe results
- [ ] `research.md` Observed ACP protocol fixtures section is complete and can be cited by the future implementation plan/tests
- [ ] `todo.md` Evidence Log includes exact commands and outcomes
- [ ] Targeted probe-harness test command has been replaced with the exact `bun test ...` command that was run
- [ ] No production runtime ACP implementation was added before the gate decision
- [ ] If ACP implementation proceeds, the handoff maps future plan/todo items to `design.md` acceptance criteria, including config/docs updates for `docs/configuration.md` and `docs/operations.md`

If any check fails, follow the recovery flow:
1. Can fix directly -> fix and re-verify
2. Probe plan is infeasible -> update `plan.md`, re-submit for plan approval
3. Design is invalid -> update `design.md`, re-submit for design approval
4. Stuck -> stop and report with evidence

### Verification (Evidence)

- [ ] Run lint/typecheck: `bun run check`
- [ ] Run unit/integration tests: `bun run test`
- [ ] Run targeted probe-harness tests: replace with exact `bun test ...` command before marking complete
- [ ] Capture redacted probe summary and timing evidence

### Review / Packaging

- [ ] Summarize probe changes and findings
- [ ] Confirm no scope creep / unrelated cleanup
- [ ] Check whether related docs need updating before ACP runtime implementation
- [ ] Prepare handoff for either ACP implementation plan or revised design

## Evidence Log

- `command`: output excerpt
- before/after: evidence
- Example format:
  - `bun test tests/unit_tests/<probe-test>.test.ts`: fake ACP initialize/session/prompt/cancel cases passed.
  - `bun run scripts/probe-copilot-acp.ts --discovery`: `copilotVersion=1.0.49`, `protocolVersion=2`, `authMethods=[]`, `agentCapabilities={methods:[initialize,session/new,session/prompt], extensions:<REDACTED:3_items>}`, `updateMethod=session/update`, `terminalResponse=session/prompt response`, `stopReasons=[end_turn,cancelled]`, `callbacks=[session/request_permission]`.
  - `bun run scripts/probe-copilot-acp.ts --roi`: process p50/p90/max, ACP cold p50/p90/max, ACP warm p50/p90/max, samples, threshold decision.

## Result

- Outcome:
- Follow-ups:
