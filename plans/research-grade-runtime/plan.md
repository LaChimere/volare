# Plan

> Purpose: a reviewable plan that can be annotated. Do not implement until the plan is approved.

## Objective

Implement the approved research-grade runtime design as small, reviewable PRs that improve Volare's grounding observability, source provenance, and explicit unmediated-tooling auditability without turning Volare into a research/RAG product or weakening secure defaults.

The implementation must let Volare distinguish "transport succeeded" from "the answer had grounding evidence" using safe counters, redacted provenance, server-owned metadata, and explicit audit markers for unmediated Copilot MCP mode.

## Constraints

- Compatibility constraints:
  - Keep core runtime types protocol-neutral; OpenAI Responses wire shapes stay in `src/northbound/openai-responses/`.
  - Existing OpenAI Responses routes must remain compatible.
  - Existing journal events remain replayable; do not add a new journal kind for source refs if conditional Phase 5 proceeds.
  - `web` permission mode must continue mapping to `--allow-all-urls`, `full` to `--allow-all`, and `restricted` to no non-interactive grant flag.
- Performance constraints:
  - Grounding output scanning must inspect at most the first 256 KiB of UTF-8 output bytes.
  - Citation-like scanners must use linear-time regexes or string scans with per-pattern match caps.
  - Metrics counters must increment exactly once from live terminal turn handling, not from GET/debug/replay paths.
- Security/safety constraints:
  - Default behavior keeps Copilot builtin MCPs disabled.
  - `VOLARE_COPILOT_MCP_MODE=unmediated` is explicit local-developer risk acceptance, not a recommended default.
  - Server-owned audit/source metadata must not be stored in client-derived `requestMetadata` or echoed through client metadata.
  - `metadata.volare`, `metadata["volare.*"]`, `client_metadata.volare`, and `client_metadata["volare.*"]` must be stripped at parse time, case-insensitively, with structured WARN logging of key paths but no values.
  - Source sanitizers must run before journal persistence and before live/wire emission.
  - No raw prompts, raw tool output, source excerpts, stderr, or sensitive source metadata are newly persisted.
  - CORS remains disabled and local HTTP endpoints remain bearer-authenticated.
- Rollout constraints:
  - Implement as stacked or sequential small PRs: Phase 0, Phase 1a, Phase 1b, Phase 1c, Phase 2, Phase 3, Phase 4, and conditional Phase 5a/5b.
  - Do not implement the deferred Volare-owned tool broker in this plan.

## Assumptions

- [x] Verified A1: Current Copilot CLI integration unconditionally passes `--disable-builtin-mcps`; this plan only removes it when `VOLARE_COPILOT_MCP_MODE=unmediated`.
- [x] Verified A2: Current `/metrics` is minimal JSON and can be extended without changing endpoint shape.
- [x] Verified A3: Current OpenAI Responses adapter merges `metadata` and `client_metadata`, so reserved `volare.*` namespace stripping must occur before core/journal state sees metadata.
- [x] Verified A4: Current generic URL redaction strips search/hash but does not explicitly strip URL userinfo; Phase 0 hardens this before source refs are introduced.
- [ ] Unverified A5: Codex/Desktop may or may not render response metadata sources; conditional Phase 5b must verify behavior and keep client-visible citation UX claims deferred if unsupported.
- [ ] Unverified A6: Copilot CLI may expose stable structured tool frames under `--output-format json` with MCPs enabled; Phase 4 is a schema probe and may produce no runtime feature.

## Options Considered

### Option A — Staged grounding observability and provenance
- Summary: Implement raw counters first, then classifier/evaluator/prompt hygiene, explicit unmediated MCP mode, a standalone reserved metadata guard, tool-frame probing, and only then conditional source refs/OpenAI source metadata if a concrete source producer exists.
- Pros:
  - Preserves secure defaults.
  - Gives baseline metrics before behavior changes.
  - Keeps each PR reviewable and revertible.
  - Defers abstractions until producer data exists.
- Cons:
  - Does not immediately match ChatGPT web/deep-research behavior.
  - Some answer quality still depends on Copilot CLI behavior.
- Why chosen:
  - Best matches Volare's bridge identity and the reviewed design.

### Option B — Enable Copilot builtin MCPs by default
- Summary: Remove `--disable-builtin-mcps` globally.
- Pros:
  - Smallest immediate behavior change.
  - May improve some external-fact prompts.
- Cons:
  - Opaque unmediated actions outside Volare approval/journal boundaries.
  - No source schema, redaction, spoofing protection, or auditability.
- Why rejected:
  - Violates secure-default posture and overstates Volare's provenance visibility.

### Option C — Build a Volare-owned research/RAG engine
- Summary: Add search, browser/fetch, document store, embeddings, reranking, and synthesis pipeline.
- Pros:
  - Maximum control over retrieval and citations.
- Cons:
  - Major scope expansion beyond a local bridge.
  - Adds providers, credentials, network policy, storage, ranking, and large operational surface.
- Why rejected:
  - Over-design for the current runtime problem.

## Proposed Approach (checklist)

### PR 1 / Phase 0 — Raw grounding observability baseline

- [ ] Add bounded raw output scanner.
  - Acceptance criteria:
    - Counts citation-like markers only: markdown links with `http(s)`, bare `http(s)` URLs, and numeric/footnote refs such as `[1]`.
    - Scans at most 256 KiB of UTF-8 output bytes.
    - Boundary tests cover 256 KiB exactly, 256 KiB + 1 byte, and a multibyte UTF-8 sequence split at the scan boundary.
    - Uses linear-time string scans or regexes with per-pattern match caps.
    - Emits `groundingEvaluatedByteCount` and `groundingTruncated`; do not introduce the misleading `groundingEvaluatedCharCount` name.
    - Does not classify prompts and does not emit warning codes.
- [ ] Harden generic URL redaction.
  - Acceptance criteria:
    - Generic `url`/`uri` redaction strips username/password userinfo.
    - Percent-encoded userinfo, CRLF/newline log-injection attempts, and very long URL values are stripped or summarized without preserving secret-bearing substrings.
    - Unsupported or sensitive schemes such as `file:`, `data:`, `javascript:`, `blob:`, and `vbscript:` are replaced with scheme-only redaction markers and preserve no path/content.
    - Existing URL redaction tests cover query/hash behavior plus the new userinfo, scheme, CRLF, and length-bound cases.
- [ ] Extend backend completion logs and aggregate `/metrics`.
  - Acceptance criteria:
    - Backend completion logs include `toolObservedCount`, `sourceCount`, `citationLikeOutputCount`, `groundingEvaluatedByteCount`, and `groundingTruncated`.
    - `/metrics` includes aggregate counters only: `turns_total`, `turns_with_zero_tools_total`, `turns_with_sources_total`, `turns_with_citation_like_output_total`, `turns_with_grounding_warnings_total`, and `turns_unmediated_total`.
    - `turns_total` and other grounding counters increment only after an authenticated request is parsed, accepted as a terminal turn, and is about to invoke backend/live handling; auth failures, parse failures, and rejected requests do not increment turn counters.
    - `turns_with_grounding_warnings_total` is expected to remain `0` until Phase 1 warning evaluation exists; it counts content-grounding warnings only and excludes `UNMEDIATED_TOOLING_ENABLED`.
    - `turns_unmediated_total` counts accepted turns where `unmediatedToolingEnabled=true`.
    - `/metrics` grounding-counter keys are asserted as a closed aggregate set for this phase while preserving existing non-grounding keys such as status/uptime/request counts; per-domain, per-warning-code, per-session, per-host, source-URL, and prompt-derived keys fail tests.
    - Counters increment exactly once from live terminal turn handling: a live terminal turn changes the relevant counter delta by `1`, N concurrent accepted live turns change it by `N`, while `/metrics` GETs, debug reads such as `/debug/turns/:id/events`, and journal replay do not increment any counter.
    - Extending `/metrics` does not enable CORS or weaken bearer-auth behavior.
- [ ] Establish baseline corpus.
  - Acceptance criteria:
    - Baseline corpus is documented in this plan and can be reused by later phases.
    - Baseline includes at least 10 prompts covering code-only, external-fact, mixed, and general tasks.
    - Before capture, each baseline prompt is checked for transport feasibility under the current default MCP-disabled setup; if a prompt fails transport rather than answer quality, record the reason and substitute a comparable prompt or recorded e2e fixture.
    - Phase 0 records per-prompt raw counter evidence for all baseline prompts through the same live/backend path used by Volare; if a prompt must use a recorded e2e fixture instead, the reason is recorded.
    - Baseline capture is a one-shot evidence snapshot, not a deterministic regression test; external prompts are expected to show zero sources under the default MCP-disabled posture.
    - Evidence records at least `groundingEvaluatedByteCount`, `groundingTruncated`, `citationLikeOutputCount`, `sourceCount`, `toolObservedCount`, and `warningCodes.length` for each prompt.
    - Phase 1 work may not start until baseline evidence is recorded in the PR evidence or `todo.md` Evidence Log.

Baseline corpus:

| ID | Category | Prompt |
|---|---|---|
| `code-fix-test` | code-only | "Find why the TypeScript tests fail and suggest the minimal code fix." |
| `code-refactor` | code-only | "Refactor the request logging helper without changing behavior." |
| `code-docs` | code-only | "Explain how the OpenAI Responses adapter reconstructs stored output from events." |
| `external-13f` | external-fact | "搜索最近各机构披露的 13F，按机构总结它们的持仓变化" |
| `external-current-news` | external-fact | "Search recent public reports about AI infrastructure spending and summarize the sources." |
| `external-doc-compare` | external-fact | "Compare the latest public documentation for two JavaScript package managers and cite sources." |
| `external-security-advisory` | external-fact | "Find recent advisories for a named package and summarize affected versions with links." |
| `mixed-code-current-docs` | mixed | "Given this code pattern, check the latest docs and explain whether the API usage is still recommended." |
| `mixed-debug-web` | mixed | "Debug this local error, and if it depends on current upstream behavior, cite the upstream source." |
| `general-advice` | general | "Explain the tradeoffs between strict and lenient input validation in local developer tools." |

### PR 2a / Phase 1a — Pure grounding hints and signals

- [ ] Add conservative grounding classifier and grounding evaluator as pure helpers.
  - Acceptance criteria:
    - Phase 0 baseline evidence exists before this PR changes behavior.
    - `RequestDomainHint` is exactly `code | external_research | general`.
    - `GroundingWarningCode` is exactly `NEEDS_SOURCES_NO_SOURCES | UNMEDIATED_TOOLING_ENABLED | CITATION_LIKE_TEXT_WITHOUT_SOURCES`.
    - `IRequestGroundingHint` carries `domain` and `needsSourceGrounding`.
    - `IAnswerGroundingSignals` carries `domain`, `needsSourceGrounding`, `citationLikeOutputCount`, `sourceCount`, `toolObservedCount`, `unmediatedToolingEnabled`, `evaluatedByteCount`, `truncated`, and `warningCodes`.
    - Signal types do not add answer-quality verdict labels.
    - `classifyRequestGrounding` returns `code`, `external_research`, or `general`.
    - Mixed prompts choose `external_research` when any subtask needs external facts.
    - The first classifier stays synchronous and pure; no model calls, network calls, backend routing, or new interface until a second implementation exists.
    - Classifier fixtures cover English current/fresh/search language and Chinese terms such as `搜索`, `最近`, `最新`, and `披露`; matching is deterministic after Unicode normalization and avoids broad partial-word triggers.
    - `evaluateAnswerGrounding` produces warning codes only from the approved string union.
    - Evaluator scans at most the first 256 KiB of UTF-8 output bytes, reports `evaluatedByteCount`, and treats `groundingTruncated=true` as a known false-negative risk in docs/log interpretation.
    - Reachable warning codes in this phase are `NEEDS_SOURCES_NO_SOURCES` and `CITATION_LIKE_TEXT_WITHOUT_SOURCES`; `UNMEDIATED_TOOLING_ENABLED` remains reserved until Phase 2.

### PR 2b / Phase 1b — Conditional prompt grounding rules

- [ ] Add conditional prompt grounding rules.
  - Acceptance criteria:
    - Grounding rules are injected after existing context-provenance rules and before user/system-supplied instructions.
    - Prompt assembly snapshot captures a full backend prompt for an external-research task and proves, using clear delimiters or line-numbered sections, that context-provenance rules appear first, grounding instructions second, and user/system-supplied content after those Volare rules.
    - Prompt rules ask for URL-bearing citations when available, relevant dates/version context, and explicit disclosure when grounding is unavailable.
    - Code-only prompt snapshots do not gain external-research instructions.

### PR 2c / Phase 1c — Grounding log fields and docs hygiene

- [ ] Extend logs with Phase 1 fields.
  - Acceptance criteria:
    - Backend completion logs include `groundingDomain`, `needsSourceGrounding`, `unmediatedToolingEnabled`, and `groundingWarningCodes`.
    - `UNMEDIATED_TOOLING_ENABLED` remains unreachable until Phase 2.
    - Phase 1 comparison uses the Phase 0 baseline and shows signals are emitted without code-only prompt regressions: code-only baseline prompts do not emit `NEEDS_SOURCES_NO_SOURCES` or `CITATION_LIKE_TEXT_WITHOUT_SOURCES`, and raw `citationLikeOutputCount` / `sourceCount` changes are explained rather than treated as source-grounding regressions.
- [ ] Update docs for prompt/docs hygiene.
  - Acceptance criteria:
    - Docs explain that prompt instructions do not create source provenance by themselves.
    - Operations docs distinguish backend/tool-content failures, such as Python certificate failures, from Volare transport failures.
    - `docs/codex-integration.md` and `docs/configuration.md` align with current permission args.

### PR 3 / Phase 2 — Explicit unmediated MCP capability mode

- [ ] Add `VOLARE_COPILOT_MCP_MODE=disabled|unmediated`.
  - Acceptance criteria:
    - Default is `disabled`.
    - In default `disabled`, Copilot argv still includes `--disable-builtin-mcps`.
    - `unmediated + restricted` is invalid config.
    - `unmediated + web/full` emits one high-visibility WARN at startup and is documented as explicit local-developer risk acceptance; per-turn visibility comes from audit fields, not repeated startup WARN spam.
    - Copilot args omit `--disable-builtin-mcps` only in `unmediated` mode.
- [ ] Emit per-turn unmediated tooling audit.
  - Acceptance criteria:
    - Every unmediated turn emits `UNMEDIATED_TOOLING_ENABLED`.
    - Exactly one dedicated server-owned `turn.audit` structured log record is emitted per accepted turn in both `disabled` and `unmediated` modes, including errored or aborted turns.
    - `turn.audit` is emitted at the same accepted-live-turn boundary that increments `turns_total`, after auth/parse/config validation and before backend spawn, so unmediated capability is recorded before Copilot can run.
    - `turn.audit` fields include server-owned correlation IDs (`sessionId`, `turnId`, and response/request ID if available), `copilotMcpMode`, `copilotPermissionMode`, and `unmediatedToolingEnabled`.
    - `turn.audit` contains no prompt text, workspace paths, client metadata, source refs, tool output, or other client-derived fields.
    - Replaying a journal never emits `turn.audit`; exactly-once tests assert live accepted turns produce one audit each, N concurrent accepted turns produce N audits, auth/parse/rejected requests produce none, and replay produces zero additional audit records.
    - Backend completion logs may keep ordinary completion summaries, but exactly-once tests count only `turn.audit` records; a durable `security` journal mirror is deferred to a later design.
    - Audit fields are not written into client-derived `requestMetadata`, SSE/live event frames, debug event payloads, or OpenAI response metadata in either `disabled` or `unmediated` mode.
- [ ] Update security docs.
  - Acceptance criteria:
    - Docs state that Volare approvals do not mediate Copilot internal MCP actions.
    - `docs/architecture.md` clarifies that unmediated MCP mode is passthrough capability exposure, not a full MCP manager or bridge-owned tool execution.

### PR 4 / Phase 3 — Reserved Volare metadata namespace guard

- [ ] Add reserved Volare metadata namespace guard.
  - Acceptance criteria:
    - Parser strips any direct or nested object key inside `metadata` or `client_metadata` whose NFKC-normalized, case-folded key is `volare` or starts with `volare.`.
    - Matching trims surrounding whitespace and covers ASCII `volare`, case variants, dotted forms such as `volare.sources`, fullwidth forms normalized by NFKC, arrays of objects, and nested object keys.
    - Unicode confusables that do not normalize to ASCII `volare` are treated as ordinary client metadata and cannot override server-owned ASCII `volare.sources`; tests document this boundary.
    - Stripping emits a structured WARN with key paths but no values.
    - Stripping happens before `requestMetadata` is constructed, before journal write, and before logs that include request metadata.
    - Tests cover dotted and nested-object input shapes, arrays of objects, mixed case, fullwidth/NFKC fixtures, non-object/null/array metadata, duplicate casing, prototype-pollution keys such as `__proto__` / `constructor` / `prototype`, and preservation of safe metadata.
    - No server-owned `volare.*` response metadata is introduced before this guard lands.

### PR 5 / Phase 4 — Copilot tool-frame schema probe

- [ ] Add redacted fixture capture path for Copilot JSON frames.
  - Acceptance criteria:
    - Capture helper applies the production redactor before writing fixtures.
    - Fixtures cover text-only and unmediated-MCP turns.
    - Positive poisoned-input tests prove the capture path redacts each protected class before fixture write.
    - Fixture capture fails closed: any redactor exception or post-write secret-pattern rejection deletes the candidate fixture and fails the test/CI step.
    - CI rejects fixtures with absolute local paths, bearer tokens, signed URLs, JWTs matching `eyJ...`, AWS `AKIA`/`ASIA` keys, GitHub `ghp_`/`gho_`/`ghs_` tokens, private-key blocks, `X-Amz-Signature=`, `sig=`, or `https://user:pass@`.
    - Runtime redaction and fixture rejection share one documented pattern source; if a separate CI scanner is unavoidable, a drift-prevention test must prove both use the same pattern inventory.
- [ ] Update parser tests for structured frames.
  - Acceptance criteria:
    - Known text deltas still become answer text.
    - Unknown structured frames are not silently treated as answer text.
    - No raw frame payload is journaled.
- [ ] Record tool-frame decision.
  - Acceptance criteria:
    - If stable tool-call frames exist, create a decision record for future lifecycle events.
    - If stable frames do not exist, keep only unmediated tooling warning and do not invent tool lifecycle events.
    - Runtime changes are optional; fixtures/tests/decision record may be the only output.

### Conditional PR 6a / Phase 5a — Core `SourceRef`, typed redaction, and journal safety

- [ ] Confirm source producer precondition.
  - Acceptance criteria:
    - Do not implement `SourceRef` persistence or emission until a concrete source producer exists or is implemented in the same PR.
    - Acceptable MVP producers must be Volare-observable and testable, such as stable Copilot tool frames from Phase 4 or a separately approved bridge-owned producer; do not derive source refs merely from citation-like answer text.
    - If no producer exists, defer Phase 5a/5b and keep the completed Phase 3 namespace guard and Phase 4 probe as the current endpoint.
- [ ] Add minimal source types.
  - Acceptance criteria:
    - Type inventory is explicit: `SourceRefId`, `IUrlSourceRef`, `IWorkspaceSourceRef`, `SourceRef`, `ISourceRefTruncation`, and optional `IAgentOutput.sources` / `IAgentOutput.sourceTruncation`.
    - `SourceRef` supports URL and workspace-relative sources only.
    - `ISourceRefTruncation` captures `originalCount`, `persistedCount`, and reason exactly `source_count_limit | source_byte_limit`.
    - `IAgentOutput.sources?: SourceRef[]` and `sourceTruncation?: ISourceRefTruncation` are optional and additive.
    - No excerpt, span, score, provider metadata, or tool-output source refs are added.
    - Existing `items` and `metadata` fields are not used as source/provenance escape hatches.
- [ ] Add source factories/validators.
  - Acceptance criteria:
    - URL refs allow only `http` and `https`.
    - URL refs reject userinfo and strip/summarize credential-like query/hash names and values, including `authorization`, `token`, `access_token`, `refresh_token`, `api_key`, `apikey`, `key`, `secret`, `password`, `signature`, `sig`, `x-amz-*`, JWTs, GitHub tokens, AWS access keys, private-key blocks, and signed URL signatures.
    - Workspace refs reject absolute paths, `..`, ASCII control characters `0x00-0x1F` and `0x7F`, newlines, mixed-separator escapes, and paths that fail `path.resolve(workspaceRoot, candidate)` containment.
    - Workspace refs are advisory references; Volare must not dereference workspace source paths during redaction, logging, encoding, replay, or debug emission.
    - If a producer dereferences workspace paths, tests cover symlink/realpath containment; producers that only record lexical refs must not read through symlinks, and docs warn consumers not to dereference workspace refs without their own containment check.
    - `SourceRefId` is unique within a turn and stable across replay; IDs are generated once at source-production time with `source_<uuid-v4>`, persisted with the event, and replay uses persisted IDs without regenerating them.
    - Duplicate URLs within one turn and across different turns still receive distinct IDs.
    - Source titles are optional, capped at 256 UTF-8 bytes, stripped of control chars/newlines/ANSI escapes, neutralized for markdown/HTML/log-forging injection, and pass typed source redaction including credential/secret-substring redaction.
    - Redacted URLs are capped at 2 KiB.
    - At most 100 source refs and at most 64 KiB of serialized sanitized source-ref payload are persisted per turn; truncation uses `source_count_limit` or `source_byte_limit` explicitly.
- [ ] Add typed fail-closed source redaction.
  - Acceptance criteria:
    - `redactSourceRef` uses an exhaustive discriminated-union switch.
    - Missing source variants fail closed before persistence.
    - Sanitizer runs before journal persistence and before live/wire emission.
    - No path outside the sanitizer output observes unsanitized `SourceRef` data, including logs, metrics derivation, SSE/live frames, replay, debug endpoints, and OpenAI encoders.
    - Generic URL redaction remains hardened from Phase 0.
- [ ] Add journal/replay safety.
  - Acceptance criteria:
    - Old events without sources replay successfully.
    - New source-bearing events replay successfully.
    - Interleaved old and source-bearing events in the same journal replay successfully.
    - Readers tolerate unknown optional `sources` / `sourceTruncation` fields without requiring migration.
    - Replay always revalidates and re-redacts source refs before re-emission using the current `redactSourceRef`; stale persisted sanitization is not trusted as the only defense.
    - Persisted sources live only on sanitized terminal `IAgentOutput.sources` / `IAgentOutput.sourceTruncation`, not request metadata, `items`, client metadata, debug-only side channels, or free-form event metadata.
    - Mixed-version replay assumptions are tested without adding a new journal kind.
- [ ] Update source/debug docs.
  - Acceptance criteria:
    - Docs state that source-bearing debug events reveal source history even after content redaction.
    - Docs state workspace refs are advisory and must not be dereferenced by consumers without containment checks.

### Conditional PR 6b / Phase 5b — OpenAI adapter source metadata

- [ ] Verify reserved metadata guard across the OpenAI adapter.
  - Acceptance criteria:
    - The Phase 3 reserved namespace guard remains active before metadata enters core state or journals.
    - Adapter tests prove stripped spoofed metadata cannot appear in `turn.created` or response metadata.
    - Adapter tests cover legacy pre-guard journal/request metadata containing `volare` / `volare.sources`; response encoding still ignores it and uses only sanitized `IAgentOutput.sources`.
    - Encoder tests prove server-written `volare.sources` survives the response pipeline and is not stripped by the request-side guard.
- [ ] Encode server-owned `volare.sources`.
  - Acceptance criteria:
    - Response metadata shape is exactly `{ "volare.sources": { "version": 1, "items": [...], "truncation"?: ... } }`.
    - URL item fields are exactly `id`, `kind: "url"`, `url`, optional `title`, and optional `retrieved_at_ms`; no camelCase core fields or extra producer metadata leak onto the wire.
    - Workspace item fields are exactly `id`, `kind: "workspace"`, `path`, and optional `title`.
    - Truncation wire fields are `original_count`, `persisted_count`, and `reason`; `truncation` is omitted when no truncation occurred.
    - Encoder is the sole writer of `volare.sources`.
    - Encoder input is exclusively sanitized `IAgentOutput.sources` and `sourceTruncation`; it does not read `requestMetadata`, `metadata`, `client_metadata`, or other client-derived structures.
    - Client metadata never overrides or merges into `volare.sources`.
    - Safe non-Volare client metadata remains compatible and cannot override server-owned source metadata.
- [ ] Verify client behavior.
  - Acceptance criteria:
    - Send a test Responses request that includes server-owned `volare.sources` metadata through the target Codex/Desktop path, record client/version/method, and capture either a response JSON excerpt, log excerpt, screenshot, or explicit "no UI surface observed" note.
    - If clients ignore metadata, source refs remain internal/diagnostic and client-visible citation UX claims stay deferred.

### Optional follow-up — Grounding signal refinement

- [ ] Refine classifier keywords and warning thresholds from Phase 0-4 evidence.
  - Acceptance criteria:
    - Refinements are backed by baseline corpus evidence.
    - Execute only when evidence shows repeated false-positive/false-negative warnings or user-reported misclassification that the existing pure helper cannot handle.
    - No new grounding domains or warning codes are added without a separate design update.
    - Classifier remains a pure synchronous helper; no model calls, external lookups, or backend routing are introduced.
    - No backend routing, answer blocking, answer rewriting, or extra research engine behavior is introduced.
    - Regressions on code-only prompts are not introduced.

## Touch Surface

- Key files/modules likely to change:
  - `src/backends/copilot-cli/backend.ts`
  - `src/core/types.ts`
  - `src/core/grounding-classifier.ts` or co-located pure helper
  - `src/core/answer-grounding-evaluator.ts` or co-located pure helper
  - `src/server/config.ts`
  - `src/runtime/server.ts`
  - `src/server/app.ts`
  - `src/northbound/openai-responses/adapter.ts`
  - `src/events/redaction.ts`
  - `src/events/sqlite-event-journal.ts`
  - `docs/architecture.md`
  - `docs/configuration.md`
  - `docs/codex-integration.md`
  - `docs/operations.md`
- Public API / schema impacts:
  - Conditional Phase 5 only: optional `IAgentOutput.sources` and `sourceTruncation`.
  - Conditional Phase 5b only: additive OpenAI Responses metadata under server-owned `volare.sources`.
  - Additive aggregate `/metrics` counters.
  - New `VOLARE_COPILOT_MCP_MODE` environment variable.
- Data impacts:
  - No migration through Phase 4.
  - No migration in conditional Phase 5 if sources remain optional fields on existing event payloads.
  - No new journal kind for source refs if conditional Phase 5 proceeds.
  - No new journal kind is required for Phase 2 audit; a durable security-journal mirror is deferred to a later design.

## Verification Plan (Done = Evidence)

### Target verification level

- [ ] L1 for PR 1 raw counters/redaction hardening.
- [ ] L2 for PR 2a pure classifier/evaluator behavior.
- [ ] L2 for PR 2b prompt assembly behavior.
- [ ] L1 for PR 2c logs/docs hygiene, plus regression comparison against Phase 0 evidence.
- [ ] L2 for PR 3 unmediated MCP capability and audit.
- [ ] L2 for PR 4 reserved metadata namespace guard.
- [ ] L2 for PR 5 fixture capture/parser behavior.
- [ ] L2 for conditional PR 6a source refs/redaction/journal, only if the producer precondition is met.
- [ ] L2 for conditional PR 6b OpenAI metadata encoding/spoofing protection, only if PR 6a proceeds.

### Evidence to produce

- [ ] Tests to run after each code PR:
  - `bun run check`
  - `bun run test`
- [ ] Additional command when CLI startup/config behavior changes:
  - `bun run package`
  - Always run when `src/server/config.ts`, `src/runtime/server.ts`, CLI startup wiring, or packaged entry behavior changes.
  - Per-PR expectation:
    - PR 1: not required unless packaging/startup files change.
    - PR 2a: not required unless packaging/startup files change.
    - PR 2b: not required unless packaging/startup files change.
    - PR 2c: not required unless packaging/startup files change.
    - PR 3: required.
    - PR 4: not required unless packaging/startup files change.
    - PR 5: not required unless packaging/startup files change.
    - PR 6a: not required unless packaging/startup files change.
    - PR 6b: not required unless packaging/startup files change.
- [ ] Before/after behavior proof:
  - Baseline corpus output scanner counters before Phase 1, recorded per prompt.
  - Phase 1 comparison showing signals are emitted and code-only prompts do not regress.
  - Phase 2 manual smoke with `VOLARE_COPILOT_MCP_MODE=disabled` and `unmediated`.
  - Phase 3 spoofing tests for metadata/client_metadata reserved namespace.
  - Phase 4 fixture/parser test output.
  - Conditional Phase 5 source producer, redaction, replay, wire metadata, and client-rendering evidence if Phase 5 proceeds.
- [ ] Logs/traces/metrics to capture:
  - Backend completion logs with grounding fields.
  - `/metrics` aggregate counters.
  - Dedicated `turn.audit` structured log record for disabled and unmediated MCP mode.
  - Redaction test evidence for URL/source refs.

## Rollback / Recovery

- Rollback plan:
  - PR 1: remove/ignore new log fields and counters; no state migration.
  - PR 2a/2b/2c: feature-gate or remove prompt additions/classifier/evaluator/log fields; no state migration.
  - PR 3: set `VOLARE_COPILOT_MCP_MODE=disabled` and restart; no state migration.
  - PR 4: remove guard only if no server-owned `volare.*` response metadata has shipped; otherwise keep it for spoofing compatibility.
  - PR 5: disable fixture/probe path; MCP-disabled behavior unaffected.
  - PR 6a/6b: disable source emission; optional fields and same journal kind avoid migration.
- Data safety notes:
  - Source refs must be sanitized before persistence and wire emission.
  - Source-bearing debug events reveal source history even after content redaction; docs must make this clear.
  - Reserved `volare.*` metadata is server-owned and must be stripped from client metadata at parse time with key-path-only WARN logging.
- Feature flag / config toggles:
  - `VOLARE_COPILOT_MCP_MODE=disabled|unmediated`

## Risks / Non-goals

- Risks:
  - Copilot CLI may not expose stable tool frames.
  - Codex/Desktop may ignore source metadata.
  - Prompt-only grounding rules may not materially improve quality; this is directional evidence, not proof.
  - Unmediated MCP mode weakens Volare's mediation boundary by design and must remain explicit.
- Explicit non-goals:
  - No 13F-specific logic.
  - No full research/RAG/deep-research engine.
  - No Volare-owned search/browser/vector/reranker pipeline.
  - No default MCP enablement.
  - No answer rewriting, blocking, or hidden second pass.
  - No tool broker in this plan.

## Review Notes / Annotations

(Place for inline user comments. Agent should incorporate these into the plan before coding.)

## Approval

- [x] Plan approved by: User approval in chat ("好的，我 approve")
- Date: 2026-05-17
