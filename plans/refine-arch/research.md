# Volare architecture refinement research

## Executive summary

Two rounds of research converged on the same primary conclusion: Volare is a **stateful local agent-runtime bridge**, not a stateless model proxy. Its core value is not translating OpenAI-compatible requests to another HTTP model endpoint; it is managing durable threads, turns, backend sessions, workspace isolation, approvals, cancellation, ACP worker lifecycle, and replayable events around a local agent backend.[^double-confirm-stateful]

The second round corrected several earlier broad refactor ideas. Model routing, a full tool broker, and broad config reshaping should not be the immediate next steps because Volare still has one real backend and its current docs keep multi-provider and client-side tool brokering out of scope.[^double-confirm-remove-router] The highest-value work is tightening the runtime control plane: approval resolution, session/worker capacity, worker admission, observability, and hot-path state/journal behavior.[^double-confirm-debt]

ACP remains the right Copilot runtime surface to continue investing in, but it must stay probe-gated. GitHub documents Copilot CLI ACP as public preview, and current/native cancellation behavior still cannot be assumed stable.[^official-acp-preview] The custom `AcpJsonRpcPeer` should remain for now because it already owns Bun-compatible flushing, per-request timeouts, kill/force-cancel behavior, worker pooling, and structured diagnostics that the SDK does not currently replace cleanly.[^sdk-keep-custom]

## Scope and sources

This research synthesizes two prior reports:

1. `research/acp-github-copilot-model-proxy.md` — first-pass research across Volare internals, ACP/Copilot integration surfaces, model proxies, adjacent protocols, security, and refactor strategy.
2. `research/double-confirm.md` — second-pass verification against current `main`, official ACP/Copilot docs, SDK adoption evidence, model gateways, adjacent protocols, worker admission, and updated roadmap.

The double-confirm report is treated as the current source of truth where it corrects the first pass.

## Confirmed architecture classification

Volare should be described as a **stateful local agent-runtime bridge**:

- It persists workspace/thread/session/turn/approval state in SQLite rather than forwarding independent stateless requests.[^double-confirm-stateful]
- It records and replays canonical events through an event journal.[^double-confirm-stateful]
- It owns cancellation and restart recovery semantics.[^double-confirm-stateful]
- It manages long-lived ACP workers and per-turn process fallback runners.[^double-confirm-stateful]

This differs materially from LiteLLM, Portkey, and Helicone. Those systems primarily normalize or route stateless HTTP calls across providers. Their patterns are useful as references for retry budgets, trace IDs, and stream handling, but their multi-provider gateway architecture is not Volare's target architecture.[^gateway-contrast]

## Double-confirmed key findings

### 1. Keep the custom ACP peer for now

The official ACP TypeScript SDK is active and relevant, but full adoption should be deferred. The custom peer currently provides capabilities that matter for Volare's production behavior:

- Bun `FileSink` support and explicit `flush()` after writes.
- Per-request timeout control.
- Structured logging and controlled diagnostics.
- Permission policy handling suitable for headless operation.
- Integration with worker-pool lifecycle, SIGTERM/SIGKILL fallback, and native cancel validation.[^sdk-keep-custom]

Low-risk future adoption could start with type/schema imports only, but runtime transport replacement is not recommended until SDK stability and Bun stream compatibility improve.[^sdk-keep-custom]

### 2. Native ACP cancel remains unsafe as a default

ACP specifies `session/cancel` as a notification and the ideal terminal outcome is an in-flight prompt resolving with `stopReason: "cancelled"`. Current Copilot CLI evidence still shows cancellation resolving with `stopReason: "end_turn"`, so Volare's default `kill` and `auto => kill` behavior remains the safe path.[^native-cancel]

Volare's current strategy — native path only behind explicit strategy/support evidence, fallback to kill-and-replace otherwise — is aligned with the observed protocol uncertainty.[^native-cancel]

### 3. Approval resolution is currently the clearest high-priority architecture gap

The codebase has an approval provider and resolution implementation, but the app layer has no approval-resolution route, and backend capabilities do not allow external approval delivery. This leaves a real approval pipeline gap: the state machine exists, but there is no complete user/API path to resolve approval requests.[^approval-gap]

This should be addressed before larger tool-broker work, because a future tool broker depends on reliable approval mediation.

### 4. Capacity controls are partially configured but not enforced end-to-end

`maxActiveSessions` is configured and active turn count exists, but the second research pass found no effective `startTurn` gate. ACP workers also use a hard cap that immediately throws `backend_worker_cap_exhausted` without admission queueing, backpressure, or cancellation of queued work.[^capacity-gap]

This is the most direct follow-up to the prior worker-cap incidents. A capacity/admission design should precede further increases to worker caps.

### 5. `app.ts` has too many responsibilities

`src/server/app.ts` currently mixes routing, auth handoff, SSE stream lifecycle, journal wrapping, metrics, cancellation cleanup, and OpenAI-specific error encoding. It works, but it is a boundary-smell that will make future adapters and control-plane changes harder.[^app-god-file]

The recommended next step is gradual extraction of stream lifecycle, journal middleware, metrics collection, and protocol-specific error encoding rather than a broad rewrite.

### 6. Tool broker and model router should be deferred

The second research pass corrected earlier enthusiasm for model routing and tool brokering. Current architecture docs keep multi-backend adapters and client-side tool brokering out of scope, and Volare currently has one real backend.[^double-confirm-remove-router]

A tool broker will matter later, but it should follow approval resolution and ACP permission callback integration. A model router should wait until there is a second real backend or a concrete routing need.

## Best-practice lessons from adjacent systems

### Model gateways

Adopt selectively:

- Trace/request ID surfacing helps correlate client-side failures with logs and debug journal entries.[^gateway-lessons]
- Retry should be budgeted, not just counted, if Volare later adds HTTP backends.[^gateway-lessons]
- Stream normalization should remain a two-step conversion through canonical `AgentEvent` rather than direct protocol-to-protocol transformation.[^gateway-lessons]

Avoid:

- Large multi-provider gateway sprawl.
- Client-supplied provider credentials or routing configs.
- Sync hooks that block streaming.
- Redis/Postgres/Kafka complexity for a local single-user bridge.[^gateway-avoid]

### ACP / Copilot surfaces

Best practices:

- Treat ACP as public preview and probe behavior rather than assuming compatibility.[^official-acp-preview]
- Always answer reverse permission requests in headless mode; never block waiting on stdin.[^official-acp-methods]
- Keep `session/cancel` handling defensive, because implementation behavior may lag the spec.[^native-cancel]
- Do not depend on private Copilot endpoints such as `api.githubcopilot.com`; use documented surfaces instead.[^security-private-api]

### Adjacent protocols

Useful patterns:

- MCP's SSE `id` / `Last-Event-ID` resumption is a good pattern for future event-journal-backed replay.[^protocol-lessons]
- AG-UI's interrupt schema suggests future approval events should include `toolCallId`, `responseSchema`, and `expiresAt`.[^protocol-lessons]
- LSP/MCP-style cancellation guidance reinforces that cancellation must tolerate races and late responses.[^protocol-lessons]

Defer or avoid:

- MCP draft behavior before it stabilizes.
- A2A Agent Card/federation until Volare becomes a remote agent service.
- AG-UI state snapshots or message snapshots while Codex/Responses clients still own conversation history.[^protocol-lessons]

## Security and policy constraints

Volare's current single-user local security defaults are directionally correct:

- loopback binding by default
- bearer auth
- hostile Origin rejection
- disabled CORS
- API keys from environment, not CLI arguments
- token/prompt/content redaction in logs
- workspace path realpath/canonicalization checks[^security-current]

Future shared deployments require stricter rules:

- use per-user/session GitHub tokens, not a shared service token
- do not use `mode: "copilot-cli"` for shared bridges, because official SDK docs warn about ambient host filesystem exposure
- preserve session ownership checks
- implement local content exclusion because Copilot CLI/Agent mode does not honor GitHub content exclusion policies automatically
- do not log Authorization headers, token env vars, prompts, or raw ACP payloads[^security-shared]

Legal/ToS questions remain unresolved for commercial/shared Copilot re-presentation. These require human review rather than engineering inference.[^security-tos]

## Recommended near-term priorities

1. Record baseline metrics for latency, cancellation, worker pressure, approval wait, and journal append cost.
2. Enforce `maxActiveSessions` in the runtime state machine.
3. Add approval resolution HTTP/API path to close the approval pipeline.
4. Add ACP worker admission queue with timeout and AbortSignal cancellation.
5. Add ACP worker metrics and a background idle reaper.
6. Split `app.ts` stream lifecycle, journal wrapping, metrics, and protocol error encoding.
7. Move approval waiting away from pure SQLite polling, with a polling fallback.
8. Revisit tool broker, SSE resumption, and model routing only after the control plane is stable.

## Footnotes

[^double-confirm-stateful]: `research/double-confirm.md`, sections 1 and 2.1; cites `src/state/migrations.ts:6-101`, `src/state/sqlite-store.ts:417-440`, `src/events/sqlite-event-journal.ts:136-170`, `src/backends/copilot-cli/acp-runner.ts:95-98`, and `src/core/types.ts:27`.
[^double-confirm-debt]: `research/double-confirm.md`, sections 1, 4.2, and 10.
[^official-acp-preview]: `research/double-confirm.md`, section 5.1; cites `github/docs:content/copilot/reference/copilot-cli-reference/acp-server.md` (SHA `f457fac6`) and ACP public preview status.
[^sdk-keep-custom]: `research/double-confirm.md`, sections 2.2 and 5.3; cites `agentclientprotocol/typescript-sdk:src/acp.ts`, `agentclientprotocol/typescript-sdk:src/stream.ts`, `agentclientprotocol/codex-acp:src/StdUtils.ts`, and Volare `src/backends/copilot-cli/acp.ts` / `acp-runner.ts`.
[^native-cancel]: `research/double-confirm.md`, sections 5.2 and 5.3; cites Volare ACP cancel evidence showing `stopReason: "end_turn"` and current `session/cancel` notification behavior.
[^approval-gap]: `research/double-confirm.md`, section 2.3; cites `src/backends/copilot-cli/backend.ts:104-111`, `src/core/durable-session-manager.ts:608-621`, `src/approvals/provider.ts:93-119`, and absence of `/approvals/` routes in `src/server/app.ts`.
[^capacity-gap]: `research/double-confirm.md`, sections 2.4, 2.5, and 8; cites `src/core/durable-session-manager.ts:36, 248, 388`, `src/backends/copilot-cli/acp-runner.ts:523-524`, and `plans/copilot-backend-runtime/todo.md:222-229`.
[^app-god-file]: `research/double-confirm.md`, section 4.2; cites `src/server/app.ts` responsibility overload and OpenAI-specific error encoding.
[^double-confirm-remove-router]: `research/double-confirm.md`, sections 2.6 and 2.7; cites `docs/architecture.md:34-38` as keeping multi-backend adapters and client-side tool brokering out of scope.
[^gateway-lessons]: `research/double-confirm.md`, sections 6.1 and 6.2; sources include LiteLLM, Portkey, and Helicone audit outputs.
[^gateway-avoid]: `research/double-confirm.md`, section 6.3 and 11.
[^official-acp-methods]: `research/double-confirm.md`, section 5.2; cites ACP stable method set from schema metadata, SHA `809ccd99`.
[^security-private-api]: `research/double-confirm.md`, sections 9.4 and 11; cites recommendation not to directly call private `api.githubcopilot.com` endpoints.
[^protocol-lessons]: `research/double-confirm.md`, section 7; sources include MCP 2025-06-18, A2A v1.0, AG-UI, and OpenAI Responses research.
[^security-current]: `research/double-confirm.md`, section 9.1; cites `src/server/config.ts`, `src/server/auth.ts`, `src/server/api-key.ts`, `src/logging/logger.ts`, `src/backends/copilot-cli/backend.ts`, and `src/core/workspace-resolver.ts`.
[^security-shared]: `research/double-confirm.md`, sections 9.2 and 9.3; cites official Copilot SDK multi-tenancy/security docs.
[^security-tos]: `research/double-confirm.md`, section 9.4.
