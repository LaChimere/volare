# Goal State

objective: "你来调研一下要怎么做最好。我希望在用 agent loom 的时候也能够进入 plugin 里面并且也能够安装 plugin。"
status: complete
slug: "goal-agent-loom-plugins"
turns_used: 2
turn_budget: null
docs_update_approved: false
created_at: "2026-05-04T14:27:23+08:00"
updated_at: "2026-05-04T14:37:00+08:00"

## Acceptance criteria

### User-visible behavior

- Explain whether plugin access while using Agent Loom is expected to work today.
- Identify the best path for allowing users to browse/install/use plugins without losing Agent Loom as an available backend.
- Distinguish quick configuration workarounds from product changes that Agent Loom should implement.

### Implementation scope

- Research Codex/Desktop config behavior around profiles, model providers, ChatGPT sign-in, and plugin marketplaces.
- Inspect Agent Loom's `config codex` behavior and relevant docs/tests.
- Propose a recommended design and, if the solution is clear and low-risk, implement the first safe configuration refinement.

### Validation

- Verify findings against local config/code and, where possible, Codex CLI/Desktop observable behavior or logs.
- Run relevant tests/checks for any code changes.

### Docs/status

- Keep this goal state updated with research evidence, decisions, blockers, and deferred items.
- Update project docs only if implementation changes behavior or configuration guidance.

### Deferred/out of scope

- Reverse-engineering or bypassing ChatGPT account authentication is out of scope.
- Shipping a full plugin marketplace proxy is deferred unless research shows it is required and feasible within Agent Loom's current architecture.

## Progress log

- Turn 0: Goal registered.
- Turn 1: Researched Codex plugin gating. Local config showed `config codex` selected `agent-loom` as the active top-level provider while plugin marketplaces remained installed. OpenAI Codex source shows remote plugin marketplace/list/install endpoints require ChatGPT-backed auth via `ensure_chatgpt_auth`, while provider account state is controlled by `requires_openai_auth`. Provider auth rules allow `env_key` and `requires_openai_auth` together, and request auth still prefers `env_key`.
- Turn 2: Implemented the low-risk config refinement: `config codex` now writes `requires_openai_auth = true` for the Agent Loom provider. Updated docs/tests, refreshed local Codex config, and smoke-tested `codex exec --profile agent-loom` without an override; Agent Loom requests still succeed through `AGENT_LOOM_API_KEY`.

## Deferred items

- Full Agent Loom client-executed plugin tool-call broker. reason=future_phase. Browsing and installing ChatGPT-backed plugins can use Codex/Desktop account state, but executing plugin-provided tools through Agent Loom still depends on a future tool-call broker.
- Plugin marketplace proxy inside Agent Loom. reason=out_of_scope. Codex already owns ChatGPT plugin marketplace APIs and authentication; duplicating or bypassing that service is not needed for the current goal.

## Blockers

- None.

## Completion audit

| Criterion | Evidence | Status |
|---|---|---|
| User-visible behavior: explain whether plugin access while using Agent Loom is expected to work today | Research found the prior `requires_openai_auth = false` Agent Loom provider hid ChatGPT account state from Desktop plugin UI, so the observed "Please sign in with ChatGPT to use plugins" was expected under the old config. | met |
| User-visible behavior: identify the best path for browse/install while keeping Agent Loom available | `scripts/config-codex.ts` now writes `requires_openai_auth = true` alongside `env_key = "AGENT_LOOM_API_KEY"`, preserving Agent Loom provider usage while exposing ChatGPT-backed plugin browsing/install account state. | met |
| User-visible behavior: distinguish workaround from product changes | Docs explain that browsing/installing plugins can remain available through Codex/Desktop account state, while plugin tool execution through Agent Loom remains a future bridge-owned tool-call broker. | met |
| Implementation scope: research Codex/Desktop plugin/profile behavior | OpenAI Codex source review found remote plugin marketplace/list/install paths require ChatGPT auth through `ensure_chatgpt_auth`, and provider account state is controlled by `requires_openai_auth`. | met |
| Implementation scope: inspect Agent Loom config behavior | `scripts/config-codex.ts` and local `~/.codex/config.toml` review showed Agent Loom was selected as active provider and previously wrote `requires_openai_auth = false`. | met |
| Implementation scope: implement first safe refinement | Updated `scripts/config-codex.ts`, `tests/unit_tests/scripts/config-codex.test.ts`, and `docs/codex-integration.md`; refreshed local Codex config. | met |
| Validation: verify findings against local behavior | `codex login status` reported ChatGPT login; `codex exec --profile agent-loom` succeeded both with a temporary `requires_openai_auth=true` override and after updating local config. | met |
| Validation: run relevant checks | `bun test tests/unit_tests/scripts/config-codex.test.ts tests/unit_tests/cli.test.ts`, `bun run check`, `bun run test`, and `bun run package` passed. | met |
| Docs/status: keep goal state updated | This goal state records research, implementation, deferred items, blockers, and completion evidence. | met |
| Docs/status: update project docs for behavior/config guidance | `docs/codex-integration.md` documents why `requires_openai_auth = true` is paired with `env_key` and the remaining plugin tool execution limitation. | met |
| Deferred/out of scope: no auth bypass or marketplace proxy | No bypass was implemented; Agent Loom continues to rely on Codex/Desktop ChatGPT auth for plugin marketplace access. | met |
