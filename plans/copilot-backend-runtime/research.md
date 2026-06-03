# Copilot backend runtime research

> Purpose: capture facts, evidence, and unknowns before planning/implementation.
> This is the review surface for understanding and diagnosis.

## Task

- Summary: reduce Volare's Copilot backend latency by researching a long-lived runtime channel, using agent-maestro as an architectural reference without copying its VS Code extension dependency or insecure defaults.
- Slug: `copilot-backend-runtime`
- Related plans:
  - `plans/codex-latency-observability/`
  - `plans/research-grade-runtime/`

## Current Behavior

- Observed behavior: Volare itself is a long-lived daemon, but every backend turn still spawns a fresh Copilot CLI subprocess in non-interactive `--prompt` mode.
- Expected behavior: keep the current per-turn process mode as the safe baseline, then design a measured path toward a reusable Copilot backend channel if the CLI exposes one safely.
- Scope affected:
  - `src/backends/copilot-cli/`
  - `src/core/durable-session-manager.ts`
  - `src/runtime/server.ts`
  - `src/server/config.ts`
  - tests and docs for runtime configuration and backend lifecycle

## Environment

- OS: Darwin
- Runtime/tool versions:
  - Bun project uses `bun@1.3.13` from `package.json`.
  - Local Copilot CLI help/version probe reported `GitHub Copilot CLI 1.0.49`.
  - ACP discovery probe later reported `GitHub Copilot CLI 1.0.59`.
- Commands run:
  - `copilot --help`
  - `copilot help commands`
  - `copilot --acp --help`
  - `copilot --version`
  - targeted `curl` reads of public `Joouis/agent-maestro` source snippets

No live model prompt probe was run in this research pass. The repository already contains `scripts/probe-copilot-cli.ts` for safer explicit probing when implementation planning begins.

## Evidence

### Recent latency evidence

`plans/codex-latency-observability/research.md` records recent local log aggregation:

| Signal | Observation |
|---|---|
| `http.request.completed` | p50 `0ms`, p90 `11ms`, p99 `16ms`, max `75ms` |
| `backend.turn.completed` | p50 about `54s`, p90 about `134s`, max about `588s` |
| `turn.stream.terminal` | nearly identical to `backend.turn.completed` for successful turns |

Interpretation from that plan still holds: successful end-to-end stream duration is dominated by the Copilot CLI backend runtime, not HTTP routing. The user's 13F research prompt also completed only after multiple minutes, consistent with this backend-dominated profile.

### Current Volare backend process model

- `src/backends/copilot-cli/backend.ts:41-45` defines `ICopilotPromptRunner` as the narrow seam: `run(prompt, options)`, optional `cancel`, optional `dispose`.
- `src/backends/copilot-cli/backend.ts:68-74` allows runner injection through `ICopilotCliBackendOptions`.
- `src/backends/copilot-cli/backend.ts:83-92` wires `BunCopilotPromptRunner` by default.
- `src/backends/copilot-cli/backend.ts:99-107` declares `persistentSessions: false`; sessions are durable in Volare state but not backed by persistent Copilot runtime state.
- `src/backends/copilot-cli/backend.ts:110-130` creates a backend session by canonicalizing workspace root and storing `backendSessionId -> cwd`; no process is spawned.
- `src/backends/copilot-cli/backend.ts:132-140` resumes a session as a no-op; no runtime channel is checked or reattached.
- `src/backends/copilot-cli/backend.ts:165-188` assembles the full prompt and calls `this.#runner.run(...)` for every turn.
- `src/backends/copilot-cli/backend.ts:413-436` spawns `copilot --no-color --no-custom-instructions ... --stream on --output-format json --prompt <prompt>` with `stdin: 'ignore'`.
- `src/backends/copilot-cli/backend.ts:447-480` reads stdout until EOF. Process exit is currently the response boundary.
- `src/backends/copilot-cli/backend.ts:507-516` waits for process exit and then untracks the process.
- `src/backends/copilot-cli/backend.ts:519-544` implements cancellation by SIGTERM/SIGKILL for all tracked processes in a backend session.

Net result: one OS process per backend turn; no process pool; no persistent Copilot channel.

### Session manager behavior

- `src/core/durable-session-manager.ts:57-128` creates/resolves durable thread/session/turn state before streaming.
- `src/core/durable-session-manager.ts:244-320` streams backend events through a pull-based async iterator and records terminal state.
- `src/core/durable-session-manager.ts:427-488` reserves and activates backend sessions; the backend session exists before any turn process starts.
- `src/core/durable-session-manager.ts:490-508` resumes an existing backend session for continuation turns.
- `src/core/durable-session-manager.ts:139-242` cancels by calling `backend.cancel(...)`, which today maps to process kill.

Important distinction: Volare already has durable sessions and a long-lived service. The missing piece is a long-lived Copilot execution channel behind each session or scope.

### Copilot CLI capabilities visible from help

The local `copilot --help` output includes:

- `--acp`: "Start as Agent Client Protocol server"
- `-p, --prompt <text>`: "Execute a prompt in non-interactive mode (exits after completion)"
- `-i, --interactive <prompt>`: starts interactive mode and executes an initial prompt
- `--resume`, `--continue`, and session naming flags
- `--stream <mode>` and `--output-format <format>`
- the same permission and MCP flags Volare already uses, including `--allow-all`, `--allow-all-urls`, and `--disable-builtin-mcps`

This changes the best candidate design. The reusable-channel target should be Copilot CLI ACP server mode, not terminal UI automation or ad hoc stdin writes to interactive mode.

### ACP protocol facts to carry into design

Public ACP documentation adds several important constraints:

- ACP stdio transport is newline-delimited JSON-RPC, not LSP-style `Content-Length` framing. Messages are UTF-8 JSON-RPC requests, notifications, or responses delimited by `\n`; stdout must contain only ACP messages, while stderr may carry logs.
- `initialize` uses integer `protocolVersion` and `clientCapabilities`, plus optional `clientInfo`. The response returns the negotiated integer protocol version and `agentCapabilities`.
- There is no LSP-style `initialized` notification in the documented ACP flow. After `initialize`, the client proceeds to session setup.
- `session/new` creates a protocol session and takes an absolute `cwd`. The spec says the cwd must be used for the session regardless of where the agent subprocess was spawned and should serve as a filesystem boundary for tool operations.
- `session/prompt` takes a `ContentBlock[]`; Volare's first ACP runner should wrap the existing assembled prompt as one text content block. The documented stream uses `session/update` notifications, including `agent_message_chunk`, then completes by responding to the original request with a `stopReason`. Probes must record the actual notification method name emitted by Copilot CLI.
- `session/cancel` is a notification. After cancellation, the agent must eventually respond to the original `session/prompt` request with `stopReason: "cancelled"`, and the client must keep draining updates until that response.
- Terminal and filesystem methods are reverse client callbacks. If Volare does not advertise terminal or filesystem capabilities in `clientCapabilities`, the agent must not call those methods. Permission requests are separate from terminal/filesystem capability advertisement and must be probed/handled explicitly.
- `initialize` can report `authMethods`; if Copilot CLI returns any, Volare must handle the authenticate flow before `session/new`.

Implication: any ACP implementation plan must be a real JSON-RPC peer, not a one-way stdout parser. The first Volare ACP runner should advertise minimal client capabilities, handle required reverse permission requests explicitly, and treat stdout as the ACP message stream, stderr as diagnostics only.

### Existing probe script

`scripts/probe-copilot-cli.ts` already captures useful pre-design probes, but it is not sufficient as-is for ACP approval:

- `scripts/probe-copilot-cli.ts:116-129` checks help output for `--acp`, `--prompt`, and permission flags.
- `scripts/probe-copilot-cli.ts:132-188` performs explicit non-interactive and streaming safe-prompt probes.
- `scripts/probe-copilot-cli.ts:190-227` starts `copilot --acp` and verifies whether it stays alive waiting for ACP client traffic.
- `scripts/probe-copilot-cli.ts:229-260` currently attempts an `initialize` request, but the design review found it uses Content-Length-style framing and a generic `capabilities` field. ACP stdio uses NDJSON and `clientCapabilities`, so the probe must be corrected or replaced before its ACP results are trusted.
- The current `runCommand` helper closes stdin after one write, so it is not suitable for multi-exchange ACP probes such as `initialize -> session/new -> session/prompt -> session/cancel`.
- `scripts/probe-copilot-cli.ts:263-300` checks current process-level cancellation behavior.

The script is a good starting point, but before implementation it must be corrected or replaced with persistent-pipe ACP probes that answer ACP response streaming, request/session methods, cancellation semantics, response-boundary framing, capability negotiation, permission/auth behavior, stdout/stderr separation, protocol version handling, and ROI timing.

### Observed ACP protocol fixtures

Command/action: `bun run scripts/probe-copilot-acp.ts --discovery`

Environment:

- Date: 2026-06-03
- Copilot CLI: `GitHub Copilot CLI 1.0.59`
- Prompt: `Reply with the single word OK.`
- cwd: temporary empty directory created by the probe
- MCP servers: `[]`, with `--disable-builtin-mcps`
- client capabilities: minimal `{}`; no terminal or filesystem capabilities advertised

Observed initialize behavior:

- ACP stdio accepted newline-delimited JSON-RPC.
- `initialize` with `clientCapabilities` succeeded.
- Negotiated `protocolVersion`: `1`.
- Unsupported client protocol probe requested `999`; Copilot CLI responded with its supported version, so the probe classified the behavior as `negotiated_to_1`, not as a server-side rejection.
- `agentCapabilities` summary:
  - `loadSession: true`
  - `mcpCapabilities.http: true`
  - `mcpCapabilities.sse: true`
  - `promptCapabilities.image: true`
  - `promptCapabilities.audio: false`
  - `promptCapabilities.embeddedContext: true`
  - `sessionCapabilities.list: {}`
- `authMethods`: one `copilot-login` terminal-auth method was advertised. Nested command/args payloads were redacted in probe evidence. In this logged-in local environment, `session/new` still succeeded without an explicit `authenticate` call, so implementation must handle or explicitly fail auth-required cases instead of assuming `authMethods` is empty.

Observed `session/new` behavior:

- Request shape used by the probe: `{ cwd, mcpServers: [] }`.
- Response included `sessionId` plus `configOptions`, `models`, and `modes`.
- `configOptions` exposed:
  - `mode` with 3 options
  - `model` with 22 options
  - `reasoning_effort` with 3 options
  - `allow_all` with 2 options
- Binding matrix from this discovery:
  - cwd: `session/new.cwd`
  - model: `session/new configOptions.id=model`
  - permission mode: `session/new configOptions.id=allow_all`
  - MCP mode: `session/new.mcpServers=[]` plus worker startup `--disable-builtin-mcps`
  - no-custom-instructions: worker startup flag `--no-custom-instructions`

Observed `session/prompt` behavior:

- Request shape used by the probe: one text `ContentBlock[]`.
- Update notification method: `session/update`.
- Update kinds observed: `agent_message_chunk`, `config_option_update`.
- Terminal framing: the original `session/prompt` request resolved with a result containing `stopReason`.
- Stop reason observed: `end_turn`.
- Server-to-client callback methods observed during this minimal prompt: none.
- Probe harness reverse-request policy is configurable. The default discovery policy records and rejects unsupported callbacks explicitly; behavior probes can use explicit `allow`, `deny`, or `cancelled` policies for `session/request_permission` so callback handling does not contaminate cancellation/isolation results.

Timing from this single discovery run:

| Segment | Duration |
|---|---:|
| initialize | ~646ms |
| session/new | ~10482ms |
| session/prompt | ~4349ms |

These timings are not ROI evidence yet. The ROI gate still requires the separate sample floors in `plan.md`: at least 5 process samples, 5 ACP warm-worker samples, and 3 ACP cold-worker samples, compared against recent historical `backend.turn.completed` p50/p90 evidence.

### ACP behavior and ROI probe

Command/action: `bun run scripts/probe-copilot-acp.ts --behavior-roi`

Environment:

- Date: 2026-06-03
- Copilot CLI: `GitHub Copilot CLI 1.0.59`
- Prompt for ROI samples: `Reply with the single word OK.`
- Process samples: 5
- ACP warm-worker samples: 5
- ACP cold-worker samples: 3

Behavior results:

| Probe | Observation | Interpretation |
|---|---|---|
| Cancellation | Repeated `session/cancel` was sent during a streaming-style count prompt. The probe observed 5 chunks before cancel in the final sample and the terminal `session/prompt` response still returned `stopReason: "end_turn"` after ~4751ms. | ACP `session/cancel` drain-to-`cancelled` was not proven. A future ACP runner must preserve current cancel semantics with kill-and-replace unless a stronger cancellation probe later proves native cancel. |
| Session isolation | Two ACP sessions with distinct temporary cwds were created in one worker. A nonce introduced in session A did not appear in session B's reply. | Minimal conversation/state isolation passed for the probe shape. This does not prove broad filesystem/tool isolation. |
| Multiplexing | Two concurrent `session/prompt` calls on distinct sessions both fulfilled with `stopReason: "end_turn"`. | Basic same-worker concurrency did not fail in this sample, but first implementation should still keep one in-flight prompt per worker unless deeper multiplexing tests are added. |
| Stalled/closed client | Closing the peer while a prompt was in flight rejected the pending request with `ACP peer closed`. | The harness can surface abandoned-client cleanup explicitly; production ACP shutdown still needs structured terminal handling. |
| Replacement safety | Killing one worker rejected that worker's pending prompt with `ACP peer closed`; a sibling worker completed its own prompt with `stopReason: "end_turn"`. | Kill-and-replace can be scoped to the owning worker without necessarily killing unrelated workers. Production must still test stale-cancel/replacement races. |
| Auth/failure surface | Running with a temporary `HOME` still allowed `initialize`; `session/new` returned a non-object/null result in the probe evidence. | Auth-required/fresh-home behavior needs explicit production handling; do not assume `authMethods` being advertised means normal session setup will succeed. |

ROI results:

| Metric | Process mode | ACP cold | ACP warm |
|---|---:|---:|---:|
| Samples | 5 | 3 | 5 |
| First assistant text p50 | ~8303ms | ~7090ms | ~3163ms |
| Terminal/total p50 | ~10281ms | ~7273ms | ~3354ms |

Against the historical `backend.turn.completed` p50 of ~54000ms:

- First-text warm continuation savings: ~5140ms, about 9.52% of historical p50, above the 5% threshold.
- Terminal/total warm continuation savings: ~6927ms, about 12.83% of historical p50, above the 5% threshold.

Interpretation: ACP should not be presented as a first-token latency fix. It may still be valuable for terminal completion latency because process mode continues running for several seconds after first stdout on the synthetic prompt, and Volare's backend turn is not terminal until the runner completes. Any future implementation plan must claim and test terminal-completion improvement separately from first-text improvement.

### agent-maestro findings

The useful agent-maestro lesson is architectural: it avoids per-request CLI startup by living inside a long-lived VS Code extension host and using durable model handles.

Public source snippets verified during this pass:

- `Joouis/agent-maestro/src/extension.ts:23-36` initializes the extension and eagerly calls `chatModelsCache.initialize()` during activation.
- `Joouis/agent-maestro/src/utils/chatModels.ts:7-9` calls `vscode.lm.selectChatModels()` and filters to Copilot-vendor models.
- `Joouis/agent-maestro/src/utils/chatModels.ts:43-78` uses a cache plus `initializationPromise` guard to avoid duplicate initialization.
- `Joouis/agent-maestro/src/utils/chatModels.ts:217-243` implements Jaccard bigram similarity.
- `Joouis/agent-maestro/src/utils/chatModels.ts:290-318` resolves model IDs by exact match, fuzzy match, then fallback.
- `Joouis/agent-maestro/src/server/routes/openai/openaiResponsesRoutes.ts:218-266` gets a cached model client, counts tokens, and calls `client.sendRequest(...)`.
- `Joouis/agent-maestro/src/server/routes/openai/openaiResponsesRoutes.ts:326-391` streams Responses SSE events while iterating `response.stream`.

What not to copy:

- `Joouis/agent-maestro/src/extension.ts:1`, `src/utils/chatModels.ts:1`, and `src/server/ProxyServer.ts:5` import `vscode`; Volare should remain standalone and should not depend on a VS Code extension host.
- `Joouis/agent-maestro/src/server/middleware/authMiddleware.ts:16-18` skips auth if no key is configured. Volare must keep bearer auth required.
- `Joouis/agent-maestro/src/server/ProxyServer.ts:50-53` enables default CORS middleware, while Volare keeps CORS disabled.
- `Joouis/agent-maestro/src/server/ProxyServer.ts:199-206` starts the server with only a port and advertises `0.0.0.0`; Volare should keep `127.0.0.1` as the default bind host.
- `Joouis/agent-maestro/src/server/routes/openai/openaiResponsesRoutes.ts:45-51` documents limitations: stateless Responses, only function tools, annotations empty. This reinforces that agent-maestro is not a source-grounding solution.
- `Joouis/agent-maestro/src/server/utils/openaiResponses.ts:370-400` filters unsupported tools down to function tools. Volare should keep its own protocol-neutral and explicit compatibility behavior rather than silently expanding runtime scope.

## Code Reading Notes

- `src/backends/copilot-cli/backend.ts` - owns Copilot CLI prompt formatting, subprocess spawning, stdout parsing, cancellation, and backend latency logs. This is the primary runtime-change surface.
- `src/core/durable-session-manager.ts` - owns durable sessions and turn lifecycle. It already reuses backend session records across turns; it should not need broad changes for runner-level reuse.
- `src/core/types.ts:402-458` - `IAgentBackend` and `IBackendCapabilities` are protocol-neutral. A runner-level ACP/process strategy should avoid core type churn unless ACP requires a genuinely new backend event capability.
- `src/server/config.ts:15-34` and `src/server/config.ts:86-139` - central runtime config parsing. Any future runtime mode flag belongs here and must use `VOLARE_*`.
- `src/runtime/server.ts:51-57` - production wiring point for `CopilotCliBackend`.
- `src/runtime/server.ts:71-81` - already warns when unmediated MCP is enabled. Persistent workers should initially avoid unmediated MCP because tool state and permissions are not Volare-mediated.
- `plans/codex-latency-observability/design.md:70-95` - existing latency design already defines backend timing fields and cautions about pull-path timing contamination. This plan should not duplicate that work.
- `plans/research-grade-runtime/design.md` - source refs, RAG/search, and tool provenance remain separate concerns and should not be mixed into backend-runtime optimization.

## Hypotheses (ranked)

1. **ACP server mode is the best candidate for real runtime reuse.** Copilot CLI explicitly exposes `--acp`, which is more stable than automating interactive TTY mode and more capable than non-interactive `--prompt`.
2. **Per-turn process spawn contributes to latency but may not be the dominant cost.** Prior logs show multi-minute backend durations. Process startup savings will only matter if measured startup/first-stdout time is a meaningful slice of the turn.
3. **Prompt/history growth likely compounds backend latency.** Volare serializes full conversation history into every prompt. ACP reuse should initially preserve this behavior for correctness; prompt compaction/history strategy is a separate later concern.
4. **Concurrency can worsen perceived latency.** Multiple concurrent Copilot child processes were observed during manual testing. A future bounded backend admission policy may help, but it should be evidence-driven and not bundled into the first ACP runner.

## Experiments Run

### Copilot CLI help and version

- Command/action: `copilot --help`, `copilot --acp --help`, `copilot help commands`, `copilot --version`
- Result: help confirms `--acp`, non-interactive `--prompt`, interactive mode, stream/json output, resume/continue, and permission/MCP flags. Version is `GitHub Copilot CLI 1.0.49`.
- Interpretation: ACP is the right first reusable-channel candidate; non-interactive `--prompt` remains the safe baseline.

### Copilot CLI ACP discovery

- Command/action: `bun run scripts/probe-copilot-acp.ts --discovery`
- Result: real ACP discovery succeeded on Copilot CLI 1.0.59. `initialize`, `session/new`, and `session/prompt` worked with NDJSON JSON-RPC, minimal client capabilities, temporary cwd, empty MCP server list, and one text `ContentBlock`.
- Interpretation: the core ACP prompt path is viable for further probe-gate work. Discovery also showed session-level config options for model and `allow_all`, so future implementation scoping should use observed config binding instead of assuming model/permission are only worker-startup concerns.

### agent-maestro source inspection

- Command/action: fetched public source snippets from `Joouis/agent-maestro` with `curl`.
- Result: verified long-lived VS Code extension activation, model cache initialization, cached model lookup, `client.sendRequest(...)`, SSE stream iteration, and insecure/default-incompatible server behaviors.
- Interpretation: copy the long-lived-handle and eager-warmup lessons conceptually; do not copy VS Code dependency, auth/CORS/bind defaults, or source-grounding limitations.

### Existing Volare code inspection

- Command/action: inspected backend, session manager, runtime config, runtime wiring, and existing plans.
- Result: current per-turn subprocess model is isolated behind `ICopilotPromptRunner`, and core/session types already support durable Volare sessions.
- Interpretation: implementation can be narrow if ACP can be represented as another runner. Broad core rewrites would be over-design.

## Open Questions / Unknowns

- Does Copilot CLI ACP expose a stable request method for "send this prompt and stream text deltas" that can be used without VS Code?
- Does ACP provide explicit response-boundary and completion events, or would Volare still need process exit as the turn boundary?
- Does Copilot CLI's ACP implementation follow the documented `session/cancel` behavior, including draining the original `session/prompt` response with `stopReason: "cancelled"`?
- Does `initialize` return any `authMethods`, and does Copilot CLI require an `authenticate` step before `session/new`?
- Does Copilot CLI emit `session/request_permission` in ACP mode even with Volare's non-interactive permission flags, and what minimal response should Volare use?
- Does Copilot CLI emit `session/update`, `session/notification`, or another method name for streamed turn updates?
- Can a single Copilot CLI ACP process safely host multiple independent ACP sessions, or does its implementation serialize or leak state between sessions?
- How should permission mode, MCP mode, model selection, and no-custom-instructions be represented in ACP startup, session setup, or config options?
- Does ACP expose tool/progress events that can be safely mapped later, or should the first version remain text-only like the current runner?
- How much of the observed latency is CLI startup/auth/bootstrap vs model queueing/thinking/tool work?
- How does a long-lived Copilot CLI ACP worker surface auth/token expiry, network failure, or upstream provider errors?
- Does `--resume` or `--continue` help without creating cross-thread context leakage? This should not be used until isolation is proven.

Updated after probes:

- Prompt streaming and terminal response framing are now proven for the minimal text prompt path.
- Native `session/cancel` drain-to-`cancelled` is not proven.
- First-text and terminal-completion ROI are both above threshold on the corrected synthetic samples.

## Recommendation for Plan

- Proposed direction: design a probe-gated ACP runtime path with current per-turn process mode as the default and rollback baseline.
- Treat ACP as the intended target only if its protocol probes pass. The next artifact should first record ACP prompt/stream/cancel/scope probe results and startup ROI; if those fail, return to design instead of forcing an ACP runner.
- Do not implement a generic process pool first. Because `--prompt` is supplied at process startup and stdin is ignored, a "pre-spawned prompt process" is not a real reusable channel.
- Do not copy agent-maestro's VS Code extension-host dependency. Use Copilot CLI ACP if it proves stable.
- Do not mix source-grounding/RAG/tool-provenance work into this slug.
- Suggested verification level for future implementation: L2 minimum.
  - Unit tests for config parsing, ACP frame parsing, worker lifecycle, cancellation, fallback/error paths.
  - Integration tests with a fake ACP server and fake process runner; avoid requiring real Copilot network access in normal test runs.
  - Manual/optional probe for real Copilot CLI ACP behavior before enabling the runtime mode locally.
