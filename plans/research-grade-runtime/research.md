# Research Log

## Task
- Summary: define a long-term, best-practice direction for making Volare produce research/web/data answers that are observable, source-grounded, and auditable, without compromising its local bridge security model or over-expanding the core runtime into a full research product.
- Links / inputs:
  - Session report: `log-metric.md` — Volare log/metric and research-quality deep dive.
  - Session report: `volare-python-tooling.md` — Python/tooling deep dive.
  - User-provided case study: Codex/Volare 13F answer vs. ChatGPT web 13F answer. This is a representative failure sample, not the product scope.

## Current Behavior
- Observed behavior:
  - Volare successfully transports Codex requests to a Copilot CLI subprocess and streams text deltas back to the client.
  - The case-study turn completed transport-wise: HTTP startup was fast, SSE started immediately, and the backend turn ended with `responseOutcome: "succeeded"`.
  - The answer quality was poor: no CIK/accession/source links, weak sampling strategy, no source-ranked synthesis, and no structured provenance.
  - Recent logs showed `promptSizeBucket: "16385+"` for completed turns and zero `tool.observed` events in the investigated log window.
- Expected behavior:
  - For source-grounded, tool-dependent, or externally factual tasks, Volare should either route to an explicitly research-capable mode or transparently indicate that it cannot provide source-grounded answers.
  - Answers that depend on external facts should carry source/provenance metadata or at least quality telemetry indicating that no source grounding occurred.
  - Tool failures, missing citations, and ungrounded research answers should be diagnosable without logging raw prompts, outputs, secrets, or full tool payloads.
- Scope affected:
  - `src/northbound/openai-responses/`
  - `src/backends/copilot-cli/`
  - `src/core/`
  - `src/server/`
  - `src/events/`
  - `docs/configuration.md`, `docs/codex-integration.md`, `docs/operations.md`

## Environment
- OS: macOS local development environment.
- Runtime/tool versions:
  - Volare released/started as `@lachimere/volare@0.4.0`.
  - Runtime is Bun/TypeScript.
  - Backend is GitHub Copilot CLI, spawned by Volare.
- Repro command(s), used only as one diagnostic sample:
  - User prompt in Codex: "搜索最近各机构披露的 13F，按机构总结它们的持仓变化"
  - Compare Volare/Copilot output to ChatGPT web output for the same query.

## Evidence

### Runtime/log evidence
- The likely case-study turn was request `687a8d1d-f114-4104-a835-6615e0865e58`, response `resp_fe4ae73a5c824694b446451d7762f580`, backend session `copilot_cli_bridge_session_2f1b9f605893445c8e755d328560b89d`.
- It ran from `2026-05-16T14:16:54.938Z` to `2026-05-16T14:32:48.708Z` and completed successfully with:
  - `durationMs=953774`
  - `outputChars=5110`
  - `deltaCount=2390`
  - `firstAssistantDeltaMs=25638`
  - `maxObservedInterDeltaGapMs=209227`
  - `promptSizeBucket="16385+"`
  - `responseOutcome="succeeded"`
- Whole-log summary from the session research:
  - `tool.observed` events: `0`
  - completed turns with `promptSizeBucket:"16385+"`: `16/16`
  - `/metrics` currently exposes only readiness/uptime/request count, not per-turn quality.
- Interpretation:
  - The case was not a transport failure.
  - Volare could prove delivery and latency, but not source grounding, citation presence, or answer correctness.

### Case-study evidence: 13F as one diagnostic sample
- The 13F prompt is not the target feature. It exposed a broader Volare problem: the bridge cannot currently observe or enforce source grounding, representative retrieval, tool success/failure, or domain-sensitive synthesis.
- The Volare answer used "latest 40 filings" as a sampling method, which is not representative of major institutional positioning.
- The answer had no accession numbers, CIKs, EDGAR URLs, schema version, CUSIPs, or source citations.
- Current post-January-2023 13F XML value semantics may be nearest-dollar rather than thousands, but the answer did not cite the SEC rule/schema source or the historical caveat. The issue is not only whether the number was right; it is that the claim was not auditable.
- General lesson:
  - High-quality external-fact answers need explicit sources, retrieval/sampling rationale, date/version context, transformation assumptions, and limitations.
  - Domain-specific identifiers and units matter, but Volare should solve this through generic provenance and quality gates rather than hard-coded 13F logic.

### Architecture evidence
- `src/northbound/openai-responses/adapter.ts` validates `tools` as an array when present, but the parsed core request does not retain a tools field. Client-provided tools are effectively discarded before reaching the backend.
- The OpenAI Responses adapter declares `clientSideToolCalls: false` and model metadata advertises no supported tools.
- `src/backends/copilot-cli/backend.ts` spawns Copilot CLI with:
  - `--no-custom-instructions`
  - `--disable-builtin-mcps`
  - one of `--allow-all`, `--allow-all-urls`, or no grant flag
  - `--stream on`
  - `--output-format json`
  - a single assembled text prompt
- Volare parses text deltas from Copilot CLI output, but current backend behavior does not surface structured tool calls, source URLs, or citation data as core events.
- `src/server/app.ts` `/metrics` response shape is minimal: `status`, `uptime_ms`, `requests_total`.
- `src/logging/logger.ts` and `src/events/redaction.ts` intentionally redact prompt/input/body/content-like fields, which is correct for privacy but means answer-quality debugging must use structured non-content signals.

### Open-source / community practice evidence
- Mature research systems commonly use a pipeline:
  1. plan query decomposition
  2. retrieve from multiple sources
  3. fetch/read documents
  4. compress/rerank/select sources
  5. synthesize
  6. cite
  7. trace tool calls/failures
- Examples studied in session research:
  - GPT Researcher: multi-retriever, source curation, compression, references.
  - deep-research: recursive SERP queries, visited URL list, schema-validated intermediate output.
  - OpenAI Agents SDK research bot: planner/search/writer stages and trace spans.
  - LlamaIndex CitationQueryEngine: source nodes and inline citations.
  - MCP: tool result `isError` and content-bearing partial/failure semantics.
- Volare currently has a bridge-shaped subset of this: durable state, redacted journal, structured turn logs, approval policy, and a minimal `tool.observed` event type that is not emitted by the Copilot backend in the observed logs.

## Code Reading Notes
- `src/server/app.ts` — owns HTTP auth/routing, `/metrics`, request logging, and SSE lifecycle. Current metrics are operational, not quality-oriented.
- `src/northbound/openai-responses/adapter.ts` — owns OpenAI/Codex request parsing and SSE encoding. It accepts but discards tool metadata and declares no client-side tool-call capability.
- `src/backends/copilot-cli/backend.ts` — owns backend prompt framing and Copilot CLI spawn flags. It currently disables builtin MCPs and custom instructions unconditionally, extracts text deltas, and logs backend timing/size metrics.
- `src/core/types.ts` — owns protocol-neutral runtime/event interfaces. It has `tool.observed`, but no typed source references, tool lifecycle, citation, or answer-quality score.
- `src/events/redaction.ts` and `src/events/sqlite-event-journal.ts` — own durable event redaction and journaling. Any future provenance/tool-output events must be redacted safely.
- `docs/architecture.md` — documents Volare's current scope as a protocol bridge and explicitly keeps a full MCP manager/tool broker out of current scope.
- `docs/codex-integration.md` and `docs/configuration.md` — document permission modes but do not yet make the research-quality implications and approval-bypass boundary explicit.

## Hypotheses (ranked)
1. **Primary:** Volare is currently a transport bridge, not a research-grade agent runtime.
   - Evidence: successful case-study transport metrics but poor answer; tools discarded; MCPs disabled; no citations/sources/quality telemetry.
2. **Secondary:** Re-enabling retrieval capability can improve quality, but doing it globally would weaken security/provenance guarantees.
   - Evidence: builtin MCPs are disabled for safety/isolation; `web` permission mode grants URL access inside Copilot CLI, bypassing Volare approval/journal visibility.
3. **Secondary:** Prompt-only improvements are helpful but insufficient.
   - Evidence: source-grounding instructions can reduce obvious failures, but without tool/provenance signals the bridge still cannot audit or enforce correctness.
4. **Lower confidence:** Copilot CLI may emit structured tool frames in `--output-format json` that Volare could parse.
   - Evidence: current logs have zero `tool.observed`; this requires a focused schema capture before relying on it.

## Experiments Run
- Action: Compare Volare/Copilot case-study output with ChatGPT web output.
  - Result: ChatGPT web answer used source-ranked synthesis, citations, representative selection, domain-specific caveats, and user-context synthesis; Volare answer produced an unweighted latest-40 filing list without provenance.
  - Interpretation: quality gap is systemic and product/runtime-shaped.
- Action: Inspect Volare runtime logs/metrics around the case-study turn.
  - Result: turn completed successfully; prompt bucket maxed; no structured tool events; metrics endpoint is too coarse for quality diagnosis.
  - Interpretation: transport observability is good enough to rule out SSE/core failure, but not enough to assess answer quality.
- Action: Compare against open-source research-agent practices.
  - Result: mature systems explicitly model retrieval, sources, failure states, and citation mapping.
  - Interpretation: Volare should add bridge-appropriate provenance/observability seams before attempting a full research pipeline.

## Open Questions / Unknowns
- What exact JSON frames does Copilot CLI emit for internal tool calls when builtin MCPs are enabled?
- Which builtin MCP servers are bundled/enabled by the installed Copilot CLI, and what network/filesystem/security behavior do they have?
- Can Volare safely expose an opt-in research/MCP mode without violating local workspace isolation expectations?
- Should a future behavior-profile flag exist at all, or should Volare keep source-grounding behavior request-derived and reserve explicit configuration for capability grants such as MCP mode?
- How should Codex/Desktop render source references if Volare carries them through OpenAI Responses metadata or annotations?
- What minimal quality metrics are useful without storing raw prompts/outputs?

## Recommendation for Plan
- Proposed direction:
  - Treat research-grade answers as a staged bridge capability, not a full rewrite into a retrieval engine.
  - Start with grounding observability, then prompt/docs hygiene, then explicit opt-in MCP capability, then minimal source provenance with fail-closed redaction, then Copilot tool-frame probing, conservative grounding hints, and non-blocking grounding signals.
  - Preserve secure defaults: no global MCP enablement, no raw prompt/tool-output logging, no secret-bearing proxy/env persistence.
- Risks:
  - Re-enabling MCPs globally could introduce opaque network calls, credential exposure, workspace leakage, and unjournaled tool activity.
  - Adding too much RAG/search infrastructure would over-design Volare beyond its protocol-bridge role.
  - Prompt-only fixes may create false confidence if not paired with observable sources/tool signals.
- Suggested verification level:
  - L1 for prompt/docs/schema-only phases.
  - L2 for behavior changes such as MCP capability mode, tool-frame parsing, source propagation, grounding hints, and quality/grounding metrics.
  - L3 only if a later phase introduces real network/tool execution owned by Volare.
