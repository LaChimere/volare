# Goal State

objective: "我认为你可以进行深度调研，看看这部分的 gap 在哪里？我们需要确保权限这一块都没有问题。你 fix 之后可以通过 codex cli 结合类似“apple 官网 mac mini 现在是否没有 256 GB 的版本了” 这样需要让 agent 去 web search 的 prompt 来验证 agent 的回答是否还是暗示没有权限等等。"
status: complete
slug: "goal-permission-tool-gap"
turns_used: 3
turn_budget: null
docs_update_approved: false
created_at: "2026-05-04T00:28:12.423+08:00"
updated_at: "2026-05-04T00:42:00+08:00"

## Acceptance criteria

### User-visible behavior

- Agent Loom-backed Codex/Copilot answers should not misleadingly imply that Codex UI "Full access" was ignored when the real gap is backend tool availability or bridge/tool-loop support.
- A web-research-style prompt such as asking whether Apple currently sells a 256 GB Mac mini should produce a response that is either grounded by working tool/network access or clearly and accurately describes the actual limitation.

### Implementation scope

- Identify whether the gap is in Codex client permissions, Agent Loom request parsing/metadata, Copilot CLI launch flags, Copilot CLI tool permissions, or missing Responses tool-call loop support.
- Make the smallest protocol-safe code/config change needed to remove misleading permission behavior for the current bridge.
- Keep production runtime free of test-only shortcuts and preserve existing auth/workspace isolation behavior.

### Validation

- Run targeted tests for any changed adapter/backend/server behavior.
- Run repository checks and tests required by the touched surfaces.
- Validate end-to-end through Codex CLI using an Apple Mac mini web-search-like prompt and inspect whether the answer still claims blocked permissions inaccurately.

### Docs/status

- Record the researched gap and validation evidence in this goal state.
- Update directly related docs only if behavior or configuration changes require it.

### Deferred/out of scope

- Full client-executed Responses tool-call loop may be deferred with reason=future_phase if research shows it is a larger protocol feature beyond the current fix.

## Progress log

- Turn 0: Goal registered.
- Turn 1: Researched the gap. Codex UI "Full access" is client-side state and is not forwarded through the Responses request to the Copilot CLI subprocess; Agent Loom accepted `tools` metadata but did not broker tool calls. Direct Copilot CLI comparison showed current flags produced `Permission denied and could not request permission from user` for web fetch, while adding Copilot CLI URL/tool grants allowed Apple page fetches.
- Turn 2: Implemented explicit Copilot CLI permission modes. Default `full` passes `--allow-all` for trusted local environments; `web` passes `--allow-all-urls`; `restricted` preserves old no-grants behavior.
- Turn 3: Validated targeted tests, full checks/tests/package, restarted daemon, and ran Codex CLI through the Agent Loom profile with the Apple Mac mini prompt. The final answer contained no permission-denied or blocked-tool markers.

## Deferred items

- Full Codex client-executed Responses tool-call broker. reason=future_phase. The current fix grants the Copilot CLI subprocess the URL permission needed for web-research prompts, but Agent Loom still does not broker individual Codex client tools.

## Blockers

- None.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: avoid misleading Full access implication | Codex CLI validation through Agent Loom completed without `Permission denied`, `could not request permission`, `curl blocked`, or similar markers in `/tmp/agent-loom-codex-apple.txt`. | met |
| User-visible behavior: Apple web prompt grounded or accurately limited | Validation answer stated it checked Apple official pages and gave a concise result without claiming unavailable permissions. | met |
| Implementation scope: identify the permission gap | Direct Copilot CLI tests showed current flags denied web fetch; `--allow-all-urls` and `--allow-all` allowed fetches. Source review showed Codex `tools` are accepted as metadata but not brokered to client tool execution. | met |
| Implementation scope: smallest protocol-safe fix | `src/backends/copilot-cli/backend.ts` adds permission mode argument mapping; `src/server/config.ts` adds `AGENT_LOOM_COPILOT_PERMISSION_MODE`; `src/runtime/server.ts` wires config to the backend. | met |
| Implementation scope: preserve auth/workspace/test boundaries | No server auth/workspace logic changed; mock/test-only boundaries untouched. | met |
| Validation: targeted tests | `bun test tests/unit_tests/backends/copilot-cli-backend.test.ts tests/unit_tests/server/app.test.ts` passed. | met |
| Validation: repository checks and tests | `bun run check`, `bun run test`, and `bun run package` passed. | met |
| Validation: Codex CLI end-to-end web prompt | `codex exec --profile agent-loom --sandbox danger-full-access ...` with the Apple Mac mini prompt exited 0 and produced no permission-denied markers. | met |
| Docs/status: record researched gap and evidence | This goal state records the gap, fix, validation, and deferred tool-call broker. | met |
| Docs/status: update directly related docs | `docs/configuration.md` documents `AGENT_LOOM_COPILOT_PERMISSION_MODE`; `docs/codex-integration.md` documents default `full`, optional `web` and `restricted` modes, and the remaining tool broker limitation. | met |
| Deferred/out of scope: full client-executed tool-call loop may be deferred | Recorded under Deferred items as reason=future_phase. | met |
