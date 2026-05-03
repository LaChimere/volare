# Codex CLI/Desktop L3 Integration Plan

## Problem and approach

Agent Loom's MVP bridge passed internal L2 validation, but real Codex CLI/Desktop traffic has stricter request and SSE compatibility requirements. The immediate objective is to make the existing OpenAI Responses northbound adapter compatible with realistic Codex custom-provider traffic, then validate with real Codex surfaces when available.

The approach is intentionally incremental:

1. Preserve the protocol-neutral core and keep Codex/OpenAI-specific behavior in `src/northbound/openai-responses/` or server setup/docs.
2. Accept Codex request fields that are safe to ignore for the current text-only bridge, while explicitly rejecting only behavior we cannot safely honor.
3. Tighten SSE/stored response shapes for completed, failed, and incomplete turns.
4. Add tests from Codex-like request/response transcripts before attempting real CLI/Desktop dogfood.
5. Validate with real Codex CLI and Desktop; if Desktop access is unavailable, leave a precise manual checklist rather than claiming L3 completion.

## Work slices

1. Reconfirm current Codex protocol expectations against source/research and the existing Agent Loom adapter.
2. Implement P0 request compatibility for non-empty `tools`, `tool_choice`, and `parallel_tool_calls` without introducing a local tool broker.
3. Implement Codex-compatible terminal SSE details for failed and incomplete turns.
4. Add Codex-like model catalog support or documented setup that works for both CLI and Desktop.
5. Add/adjust unit and integration tests for Codex-like requests, terminal event shapes, models, multi-turn full-history input, and cancellation.
6. Run checks, package verification, and a code review loop; resolve material findings.
7. Attempt real Codex CLI validation against a local Agent Loom server and record evidence.
8. Attempt real Codex Desktop validation or record exact blocker plus manual validation checklist.
9. Update README, AGENTS.md if conventions change, and this goal state with final evidence.

## Notes

- Minimum viable compatibility means accepting Codex's tool definitions as client capabilities, not executing them inside Agent Loom.
- If real Codex requires function/tool-call output items to continue, add that as the next interface-backed slice rather than folding a full tool broker into the P0 fix.
- `previous_response_id` remains supported, but Codex HTTP/SSE full-history `input[]` must work without it.
