# Goal State

objective: "你可以考虑和 codex cli 和 codex desktop app 进行集成并且测试了。你可以自己 research、design 和 plan 等等，多 review、rethink 等等，采用最佳实践，面向接口，但是避免 over-design。我们的最终目标是能够被 codex cli 和 codex desktop app 完美使用。"
status: active
slug: "goal-codex-cli-desktop-integration"
turns_used: 2
turn_budget: null
created_at: "2026-05-03T17:08:58.742+08:00"
updated_at: "2026-05-03T17:08:58.742+08:00"

## Acceptance criteria

- Agent Loom accepts realistic Codex CLI/Desktop OpenAI Responses requests, including non-empty `tools`, `tool_choice`, `parallel_tool_calls`, and full-history `input[]` turns.
- Agent Loom emits Codex-compatible streaming terminal events for completed, failed, interrupted, and cancelled turns, including stable response IDs and expected error/incomplete detail fields.
- Agent Loom exposes or documents a Codex-compatible model catalog path that works for CLI and Desktop setup.
- Codex CLI integration is validated with a local Agent Loom server wherever the environment provides Codex CLI access.
- Codex Desktop integration is validated directly where the environment provides the desktop app, or blocked with exact missing access and a concrete manual validation checklist.
- Multi-turn, cancellation, workspace propagation, error handling, observability/debug journal, and restart/soak scenarios are covered by tests or L3/manual validation evidence.
- Changes remain interface-oriented, keep core runtime protocol-neutral, and avoid a bridge-owned tool broker unless real Codex compatibility requires it.
- Related docs and plan artifacts are updated, checks pass, and implementation commits are atomic.

## Progress log

- Turn 0: Goal registered. Assumption: the first implementation slice should remove known P0 protocol blockers for real Codex traffic before attempting full CLI/Desktop dogfood.
- Turn 1: Reconfirmed Codex custom Responses provider expectations from current `openai/codex` research, then implemented and tested P0/P1 compatibility for Codex tool metadata, full-history `input[]`, terminal SSE error/incomplete/usage fields, and Codex `ModelInfo` models response.
- Turn 2: Validated with real Codex CLI 0.128.0 against local Agent Loom on `127.0.0.1:8765`. Single-turn `codex exec` returned `Reply exactly with AGENT_LOOM_CODEX_OK.`; persistent-session `codex exec` plus `codex exec resume --last` returned `FIRST_AGENT_LOOM_CODEX_OK` then `SECOND_AGENT_LOOM_CODEX_OK` through the same Codex CLI thread. Agent Loom state showed succeeded turns and canonical debug journal events for the CLI requests. Desktop validation was explicitly deferred after the user narrowed validation to Codex CLI only.

## Deferred items

- Full Codex tool execution lifecycle mapping is deferred until transcript evidence proves the minimal text-only bridge is insufficient.
- Codex Desktop validation is deferred by user instruction to validate only with Codex CLI for now.

## Blockers

- Codex Desktop remains unvalidated in this iteration by user instruction.
