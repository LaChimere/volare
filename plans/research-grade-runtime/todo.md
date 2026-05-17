# Task Checklist

> Purpose: execution-phase checklist derived from `plans/research-grade-runtime/plan.md`.
> Treat this as the progress truth source.

## Task

- Summary: implement Volare grounding observability, explicit unmediated MCP audit, minimal source provenance, and tool-frame probing in small PRs.
- Links:
  - Research: `plans/research-grade-runtime/research.md`
  - Design: `plans/research-grade-runtime/design.md`
  - Plan: `plans/research-grade-runtime/plan.md`

## Plan Reference

- Plan version/date: 2026-05-17
- Approved by (if applicable): User approval in chat ("好的，我 approve"), 2026-05-17

## Checklist

### Preparation

- [x] Confirm plan approval before implementation.
  - Acceptance criteria: `plans/research-grade-runtime/plan.md` Approval section is filled or user gives explicit approval such as "approved", "proceed", "LGTM", or "可以开始".
  - Evidence: User approval in chat on 2026-05-17: "好的，我 approve，你可以更新之后 commit 下".
- [x] Confirm working tree and branch state.
  - Acceptance criteria: unrelated changes are identified and not touched.
  - Evidence: 2026-05-17 on branch `lachimere/fix-tooling`; working tree was clean after `0d4ed9c docs(research-grade-runtime): register implementation goal` before Phase 0 code changes.
- [x] Confirm target verification level per PR.
  - Acceptance criteria: L1/L2 expectations from `plan.md` are preserved in each PR.
  - Evidence: Phase 0 implementation follows PR 1 acceptance criteria; each code slice runs targeted tests plus `bun run check` and `bun run test` before commit.

### PR 1 / Phase 0 — Raw grounding observability baseline

- [x] Implement bounded raw output scanner.
  - Acceptance criteria:
    - Counts markdown `http(s)` links, bare `http(s)` URLs, and `[n]`-style references.
    - Scans at most 256 KiB UTF-8 bytes.
    - Tests cover 256 KiB exactly, 256 KiB + 1 byte, and a multibyte UTF-8 sequence at the boundary.
    - Uses linear-time scans/regexes with match caps.
    - Emits `groundingEvaluatedByteCount`/truncation data without classifier or warning codes; do not introduce `groundingEvaluatedCharCount`.
  - Evidence: Added `src/core/grounding.ts` and `tests/unit_tests/core/grounding.test.ts`; `bun test tests/unit_tests/core/grounding.test.ts` passed on 2026-05-17. Full `bun run check` and `bun run test` passed before commit.
- [ ] Harden generic URL redaction.
  - Acceptance criteria:
    - Strips URL userinfo.
    - Strips/summarizes percent-encoded userinfo, CRLF/newline log-injection attempts, and very long URL values.
    - Replaces unsupported schemes such as `file:`, `data:`, `javascript:`, `blob:`, and `vbscript:` with scheme-only markers and no path/content.
    - Tests cover old and new URL redaction behavior.
  - Evidence:
- [ ] Add Phase 0 log fields and aggregate metrics.
  - Acceptance criteria:
    - Completion logs include raw grounding counters.
    - `/metrics` counters are aggregate-only and named `turns_total`, `turns_with_zero_tools_total`, `turns_with_sources_total`, `turns_with_citation_like_output_total`, `turns_with_grounding_warnings_total`, and `turns_unmediated_total`.
    - Turn counters increment only after an authenticated request is parsed, accepted as a terminal turn, and is about to invoke backend/live handling; auth failures, parse failures, and rejected requests do not increment counters.
    - `turns_with_grounding_warnings_total` remains `0` until Phase 1 warning evaluation exists; it counts content-grounding warnings only and excludes `UNMEDIATED_TOOLING_ENABLED`.
    - `turns_unmediated_total` counts accepted turns where `unmediatedToolingEnabled=true`.
    - `/metrics` grounding-counter key set is closed while existing non-grounding keys remain compatible; per-domain, per-warning-code, per-session, per-host, source-URL, and prompt-derived keys fail tests.
    - Live turns increment relevant counters once, N concurrent accepted turns increment by N, and `/metrics` GETs, debug reads, and journal replay do not increment any counter.
    - No CORS or bearer-auth posture changes.
    - No prompt, Copilot arg, or answer output behavior changes.
  - Evidence:
- [ ] Capture baseline corpus results.
  - Acceptance criteria:
    - Each baseline prompt is checked for transport feasibility under default MCP-disabled setup; transport failures are recorded and substituted with comparable prompts or recorded e2e fixtures.
    - All 10 planned prompts are run through the Volare live/backend path; fixture substitution requires a recorded reason.
    - Baseline capture is a one-shot evidence snapshot; external prompts are expected to show zero sources under default MCP-disabled posture.
    - Evidence records per-prompt `groundingEvaluatedByteCount`, `groundingTruncated`, `citationLikeOutputCount`, `sourceCount`, `toolObservedCount`, and `warningCodes.length`.
    - Baseline evidence is recorded in the PR or Evidence Log before PR 2a begins.
  - Evidence:

### PR 2a / Phase 1a — Pure grounding hints and signals

- [ ] Add conservative classifier and grounding evaluator.
  - Acceptance criteria:
    - Phase 0 baseline evidence exists before this PR changes behavior.
    - Type inventory includes `RequestDomainHint`, `IRequestGroundingHint`, `GroundingWarningCode`, and `IAnswerGroundingSignals`.
    - `IRequestGroundingHint` carries `domain` and `needsSourceGrounding`.
    - `IAnswerGroundingSignals` carries `domain`, `needsSourceGrounding`, `citationLikeOutputCount`, `sourceCount`, `toolObservedCount`, `unmediatedToolingEnabled`, `evaluatedByteCount`, `truncated`, and `warningCodes`.
    - Classifies `code`, `external_research`, and `general`.
    - Mixed external-fact prompts choose `external_research`.
    - Classifier stays synchronous and pure: no model calls, network calls, backend routing, or premature interface.
    - Fixtures cover English current/search language and Chinese terms such as `搜索`, `最近`, `最新`, and `披露`.
    - Evaluator scans at most 256 KiB UTF-8 bytes, reports `evaluatedByteCount`, and documents `groundingTruncated=true` as a known false-negative risk.
    - Emits only `NEEDS_SOURCES_NO_SOURCES` and `CITATION_LIKE_TEXT_WITHOUT_SOURCES` in this phase.
  - Evidence:

### PR 2b / Phase 1b — Conditional prompt grounding rules

- [ ] Add conditional grounding prompt rules.
  - Acceptance criteria:
    - Rules are inserted after context-provenance rules and before user/system-supplied instructions.
    - Full backend prompt snapshot uses clear delimiters or line-numbered sections proving context-provenance rules first, grounding instructions second, and user/system-supplied content after those Volare rules.
    - Code-only prompts do not get external-research instructions.
  - Evidence:

### PR 2c / Phase 1c — Grounding log fields and docs hygiene

- [ ] Add Phase 1 backend fields.
  - Acceptance criteria:
    - Logs include `groundingDomain`, `needsSourceGrounding`, `unmediatedToolingEnabled`, and `groundingWarningCodes`.
    - `UNMEDIATED_TOOLING_ENABLED` remains unreachable until PR 3.
    - Phase 1 comparison uses Phase 0 baseline; code-only prompts do not emit `NEEDS_SOURCES_NO_SOURCES` or `CITATION_LIKE_TEXT_WITHOUT_SOURCES`, and raw counter differences are explained rather than treated as source-grounding regressions.
  - Evidence:
- [ ] Update docs for prompt grounding and backend/tool-content failures.
  - Acceptance criteria:
    - Docs explain prompt rules are not provenance.
    - Docs explain Python/certificate/tool-output issues as backend/tool-content unless Volare transport fails.
    - Permission docs align with current Copilot args.
  - Evidence:

### PR 3 / Phase 2 — Explicit unmediated MCP capability mode

- [ ] Add `VOLARE_COPILOT_MCP_MODE=disabled|unmediated`.
  - Acceptance criteria:
    - Default is `disabled`.
    - Default `disabled` still passes `--disable-builtin-mcps`.
    - `unmediated + restricted` fails config validation.
    - `unmediated + web/full` emits one startup WARN; per-turn visibility comes from audit fields.
    - Only `unmediated` omits `--disable-builtin-mcps`.
  - Evidence:
- [ ] Emit unmediated tooling warning and audit fields.
  - Acceptance criteria:
    - Every unmediated turn emits `UNMEDIATED_TOOLING_ENABLED`.
    - Exactly one dedicated server-owned `turn.audit` structured log record is emitted per accepted turn in both `disabled` and `unmediated` modes, including errored or aborted turns.
    - `turn.audit` is emitted at the same accepted-live-turn boundary that increments `turns_total`, after auth/parse/config validation and before backend spawn, so unmediated capability is recorded before Copilot can run.
    - `turn.audit` fields include server-owned correlation IDs (`sessionId`, `turnId`, and response/request ID if available), `copilotMcpMode`, `copilotPermissionMode`, and `unmediatedToolingEnabled`.
    - `turn.audit` contains no prompt text, workspace paths, client metadata, source refs, tool output, or other client-derived fields.
    - Journal replay never emits `turn.audit`; tests assert live accepted turns produce one audit each, N concurrent accepted turns produce N audits, auth/parse/rejected requests produce none, and replay produces zero additional audits.
    - Backend completion logs may keep ordinary completion summaries, but exactly-once tests count only `turn.audit`; durable security-journal mirroring is deferred.
    - Audit fields are not written to `requestMetadata`, SSE/live event frames, debug event payloads, or OpenAI response metadata in either `disabled` or `unmediated` mode.
  - Evidence:
- [ ] Update MCP/security docs.
  - Acceptance criteria:
    - Docs state Volare approvals do not mediate Copilot internal MCP actions.
    - `docs/architecture.md` clarifies unmediated MCP mode is passthrough capability exposure, not a full MCP manager.
  - Evidence:

### PR 4 / Phase 3 — Reserved Volare metadata namespace guard

- [ ] Add reserved Volare metadata namespace guard.
  - Acceptance criteria:
    - Parser strips any direct or nested object key inside `metadata` or `client_metadata` whose NFKC-normalized, case-folded key is `volare` or starts with `volare.`.
    - Matching trims surrounding whitespace and covers ASCII/case variants, dotted forms such as `volare.sources`, fullwidth forms normalized by NFKC, arrays of objects, and nested object keys.
    - Unicode confusables that do not normalize to ASCII `volare` are treated as ordinary client metadata and cannot override server-owned ASCII `volare.sources`; tests document this boundary.
    - Stripping emits a structured WARN with key paths but no values.
    - Stripping happens before `requestMetadata` construction, journal write, and logs that include request metadata.
    - Tests cover dotted and nested-object input shapes, arrays of objects, mixed case, fullwidth/NFKC fixtures, non-object/null/array metadata, duplicate casing, prototype-pollution keys, and preservation of safe metadata.
    - No server-owned `volare.*` response metadata is introduced before this guard lands.
  - Evidence:

### PR 5 / Phase 4 — Copilot tool-frame schema probe

- [ ] Add redacted fixture capture helper.
  - Acceptance criteria:
    - Production redactor runs before fixture write.
    - Fixtures cover text-only and unmediated-MCP turns.
    - Positive poisoned-input tests prove each protected class is redacted before fixture write.
    - Fixture capture fails closed: any redactor exception or post-write secret-pattern rejection deletes the candidate fixture and fails the test/CI step.
    - CI rejects secret/path patterns listed in the plan, including absolute paths, bearer tokens, signed URLs, JWTs, AWS keys, GitHub tokens, private-key blocks, `X-Amz-Signature=`, `sig=`, and `https://user:pass@`.
    - Runtime redaction and fixture rejection share a documented pattern source; if a separate CI scanner is unavoidable, a drift-prevention test proves both use the same pattern inventory.
  - Evidence:
- [ ] Add parser tests for structured frames.
  - Acceptance criteria:
    - Text deltas remain answer text.
    - Unknown structured frames are not emitted as answer text.
    - No raw frame payload is journaled.
  - Evidence:
- [ ] Write tool-frame decision record.
  - Acceptance criteria:
    - Stable frames lead to a future lifecycle-event proposal.
    - Unstable/no frames means no invented lifecycle events.
  - Evidence:

### Conditional PR 6a / Phase 5a — Core source refs, redaction, journal safety

- [ ] Confirm source producer precondition.
  - Acceptance criteria:
    - Do not implement `SourceRef` persistence or emission until a concrete source producer exists or is implemented in the same PR.
    - Acceptable MVP producers must be Volare-observable and testable, such as stable Copilot tool frames from Phase 4 or a separately approved bridge-owned producer; do not derive source refs merely from citation-like answer text.
    - If no producer exists, defer Phase 5a/5b and keep Phase 3 guard plus Phase 4 probe as the current endpoint.
  - Evidence:
- [ ] Add minimal `SourceRef` and `ISourceRefTruncation`.
  - Acceptance criteria:
    - Type inventory includes `SourceRefId`, `IUrlSourceRef`, `IWorkspaceSourceRef`, `SourceRef`, `ISourceRefTruncation`, and optional `IAgentOutput.sources` / `sourceTruncation`.
    - URL and workspace refs only.
    - Optional `sources` and `sourceTruncation` on `IAgentOutput`.
    - Truncation reason is exactly `source_count_limit | source_byte_limit`.
    - No excerpts, spans, scores, provider metadata, or tool-output refs.
    - Existing `items` and `metadata` are not used as source/provenance escape hatches.
  - Evidence:
- [ ] Add source validation/factories.
  - Acceptance criteria:
    - URL refs are `http(s)` only, no userinfo, credential-like query/hash names and values handled, 2 KiB cap.
    - Credential-like values include token/password/signature/api-key names, `x-amz-*`, JWTs, GitHub tokens, AWS keys, private-key blocks, and signed URL signatures.
    - Workspace refs are relative and cannot escape workspace root; reject absolute paths, `..`, ASCII controls `0x00-0x1F`/`0x7F`, newlines, and mixed-separator escapes.
    - Workspace refs are advisory; Volare does not dereference source paths during redaction, logging, encoding, replay, or debug emission.
    - If a producer dereferences workspace paths, symlink/realpath containment is tested; lexical refs must not read through symlinks, and docs warn consumers not to dereference without containment checks.
    - `SourceRefId` is unique within a turn and stable across replay by generating once at source production with `source_<uuid-v4>`, persisting with the event, and never regenerating on replay.
    - Duplicate URLs within one turn and across different turns receive distinct IDs.
    - Titles are redacted, stripped, capped, stripped of ANSI/log-forging/rendered-injection patterns, and scanned for credential/secret substrings.
    - Max 100 refs and max 64 KiB serialized sanitized source-ref payload per turn; truncation reason records `source_count_limit` or `source_byte_limit`.
  - Evidence:
- [ ] Add typed fail-closed source redaction.
  - Acceptance criteria:
    - Exhaustive sanitizer handles all source variants.
    - Sanitizer runs before journal persistence and before wire emission.
    - Missing variants fail closed.
    - Unsanitized source refs cannot reach logs, metrics derivation, SSE/live frames, replay, debug endpoints, or OpenAI encoders.
  - Evidence:
- [ ] Add journal/replay tests.
  - Acceptance criteria:
    - Old events and source-bearing events replay.
    - Interleaved old and source-bearing events in the same journal replay.
    - Readers tolerate unknown optional `sources` / `sourceTruncation` fields.
    - Replay always revalidates and re-redacts source refs before re-emission using current `redactSourceRef`.
    - Persisted sources live only on sanitized terminal `IAgentOutput.sources` / `sourceTruncation`.
    - Mixed-version replay assumptions hold.
    - No new journal kind is introduced.
  - Evidence:
- [ ] Update source/debug docs.
  - Acceptance criteria:
    - Docs state source-bearing debug events reveal source history even after content redaction.
    - Docs state workspace refs are advisory and must not be dereferenced by consumers without containment checks.
  - Evidence:

### Conditional PR 6b / Phase 5b — OpenAI adapter source metadata

- [ ] Verify reserved Volare metadata guard across the OpenAI adapter.
  - Acceptance criteria:
    - Phase 3 parser guard remains active before core state and journaling.
    - Stripped spoofed client metadata cannot appear in `turn.created` or response metadata.
    - Legacy pre-guard journal/request metadata containing `volare` / `volare.sources` is ignored during response encoding.
    - Server-written `volare.sources` survives the response pipeline and is not stripped by the request-side guard.
  - Evidence:
- [ ] Encode server-owned `volare.sources`.
  - Acceptance criteria:
    - Metadata shape is `{ "volare.sources": { "version": 1, "items": [...], "truncation"?: ... } }`.
    - URL items use exactly `id`, `kind: "url"`, `url`, optional `title`, and optional `retrieved_at_ms`.
    - Workspace items use exactly `id`, `kind: "workspace"`, `path`, and optional `title`.
    - Truncation uses `original_count`, `persisted_count`, and `reason`; omitted when absent.
    - Encoder input is exclusively sanitized `IAgentOutput.sources` / `sourceTruncation`, never request/client metadata.
    - Response encoder is sole writer.
    - Client metadata cannot override or merge.
    - Source metadata remains sanitized.
  - Evidence:
- [ ] Verify Codex/Desktop metadata rendering.
  - Acceptance criteria:
    - Test a response containing server-owned `volare.sources`, record client/version/method, and capture response JSON/log/screenshot or explicit "no UI surface observed" evidence.
    - If ignored, source refs remain internal/diagnostic and client-visible citation UX is deferred.
  - Evidence:

### Optional follow-up — Grounding signal refinement

- [ ] Refine classifier and thresholds only if evidence supports it.
  - Acceptance criteria:
    - Baseline corpus evidence justifies changes.
    - Execute only for repeated false-positive/false-negative evidence or user-reported misclassification.
    - No new grounding domains or warning codes without a separate design update.
    - Classifier remains pure and synchronous; no model calls, external lookups, or backend routing.
    - No backend routing, answer rewriting, answer blocking, or research-engine behavior is introduced.
  - Evidence:

### Acceptance Gate (before proposing PR)

- [ ] All acceptance criteria above are met with evidence for the current PR.
- [ ] Diff is consistent with approved plan; no scope creep or missing pieces.
- [ ] Applicable verification level executed.
- [ ] Related docs are updated or explicitly deferred according to plan.

If any check fails, follow the recovery flow defined in the active framework contract:

1. Can fix directly -> fix and re-verify.
2. Plan is infeasible -> update `plan.md`, re-submit for Gate 2.
3. Design is invalid -> update `design.md`, re-submit for Gate 1 -> Gate 2.
4. Stuck -> stop and report to user with evidence of what was attempted.

### Verification (Evidence)

- [ ] Run lint/typecheck: `bun run check`
- [ ] Run unit tests: `bun run test`
- [ ] Run package when CLI startup/config behavior changes: `bun run package`
  - Required for PR 3 and whenever `src/server/config.ts`, `src/runtime/server.ts`, CLI startup wiring, or packaged entry behavior changes.
- [ ] Capture before/after grounding counters for Phase 0/1.
- [ ] Capture unmediated MCP disabled/unmediated smoke evidence for Phase 2.
- [ ] Capture spoofing evidence for Phase 3.
- [ ] Capture fixture/parser evidence for Phase 4.
- [ ] Capture source producer/redaction/replay/metadata evidence for conditional Phase 5 if it proceeds.

### Review / Packaging

- [ ] Summarize changes by PR (what/why).
- [ ] Confirm no unrelated cleanup.
- [ ] Check whether related docs need updating; use `refresh-related-docs` if behavior, configuration, or API docs drift.
- [ ] Prepare PR description with security/rollback notes.

## Evidence Log

Paste concise evidence here (commands + key lines).

### PR 1 / Phase 0

- baseline corpus counters:

| ID | `groundingEvaluatedByteCount` | `groundingTruncated` | `citationLikeOutputCount` | `sourceCount` | `toolObservedCount` | `warningCodes.length` | Notes |
|---|---:|---|---:|---:|---:|---:|---|
| `code-fix-test` |  |  |  |  |  |  |  |
| `code-refactor` |  |  |  |  |  |  |  |
| `code-docs` |  |  |  |  |  |  |  |
| `external-13f` |  |  |  |  |  |  |  |
| `external-current-news` |  |  |  |  |  |  |  |
| `external-doc-compare` |  |  |  |  |  |  |  |
| `external-security-advisory` |  |  |  |  |  |  |  |
| `mixed-code-current-docs` |  |  |  |  |  |  |  |
| `mixed-debug-web` |  |  |  |  |  |  |  |
| `general-advice` |  |  |  |  |  |  |  |

- `/metrics` exactly-once evidence:
- redaction boundary evidence:

### PR 2a / Phase 1a

- classifier/evaluator evidence:

### PR 2b / Phase 1b

- prompt assembly evidence:

### PR 2c / Phase 1c

- logs/docs evidence:

### PR 3 / Phase 2

- disabled/unmediated smoke evidence:
- `turn.audit` exactly-once evidence:
- package evidence:

### PR 4 / Phase 3

- reserved metadata guard evidence:

### PR 5 / Phase 4

- fixture/parser evidence:

### Conditional PR 6a / Phase 5a

- source producer/redaction/journal evidence:

### Conditional PR 6b / Phase 5b

- metadata/client-rendering evidence:

- `bun run check`: output excerpt
- `bun run test`: output excerpt
- `bun run package`: output excerpt when applicable
- before/after: grounding counter evidence
- logs/metrics: backend completion and `/metrics` evidence

## Result

- Outcome:
- Follow-ups:
