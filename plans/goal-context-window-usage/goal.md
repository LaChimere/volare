# Goal State

objective: "好的，现在你可以看一下 context window 的问题，我们的项目需要尽量做到反应真实的 context window 使用情况"
status: complete
slug: "goal-context-window-usage"
turns_used: 1
turn_budget: null
created_at: "2026-05-03T23:27:21.449+08:00"
updated_at: "2026-05-03T23:27:21.449+08:00"

## Acceptance criteria

- Identify why Codex/Desktop currently shows misleading context usage for Agent Loom responses.
- Replace hard-coded zero usage with a best-effort usage signal based on the actual prompt text sent to the backend and the assistant text emitted back to the client.
- Keep the implementation protocol-safe: core runtime types remain protocol-neutral, and OpenAI Responses formatting stays in `src/northbound/openai-responses/`.
- Make estimated usage explicit in Agent Loom's internal usage metadata while preserving standard Codex-compatible `input_tokens`, `output_tokens`, `total_tokens`, and details fields on the wire.
- Add tests covering streaming and stored response usage behavior.
- Run the repository validation commands before marking the goal complete.

## Progress log

- Turn 0: Goal registered. Assumption: because Copilot CLI does not currently expose authoritative tokenizer/accounting data through the bridge, Agent Loom should report conservative best-effort estimates instead of exact-looking zeroes.
- Turn 1: Added protocol-neutral internal usage metadata, heuristic token estimation for prompt/output text, backend usage emission, OpenAI Responses usage formatting with standard wire fields, and tests for backend, stream, stored response, and validation edge cases. Verified with `bun run check`, `bun run test`, `bun run package`, and a focused code-review pass.

## Deferred items

- Replacing estimates with authoritative backend token accounting if Copilot CLI exposes stable usage metadata in a future JSON stream.
- Exact Codex Desktop UI verification if the local Desktop app is not scriptable from this environment.

## Blockers

- None.
