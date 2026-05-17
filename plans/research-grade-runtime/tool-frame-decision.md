# Copilot Tool-Frame Decision

Phase 4 decision: keep Copilot structured frames as probe fixtures only, and do not introduce Volare tool lifecycle events yet.

The current fixtures prove the parser can keep `assistant.message_delta` as answer text while ignoring unknown structured frames such as MCP server and tool-shaped records. They do not prove a stable Copilot CLI tool-frame schema with call IDs, terminal ordering, redaction boundaries, or replay semantics. Until that schema is captured from real supported Copilot CLI output and reviewed, Volare should keep the existing unmediated-tooling warning/audit behavior instead of inventing `tool.called`, `tool.succeeded`, or `tool.failed` events.

Future lifecycle-event work needs a separate design covering frame schema stability, call ID scope, exactly-one terminal event rules, ordering, typed redaction, size caps, and replay behavior.
