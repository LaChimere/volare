# Agent Loom

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

Agent Loom starts a local OpenAI Responses-compatible bridge at `http://127.0.0.1:8000/openai/v1`. It requires bearer auth for every endpoint. Set `AGENT_LOOM_API_KEY` to a token with at least 16 non-whitespace characters, or the server will generate an ephemeral startup token and print it once to stderr.

Useful endpoints:

```text
GET  /healthz
GET  /metrics
GET  /openai/v1/models
POST /openai/v1/responses
GET  /openai/v1/responses/:id
POST /openai/v1/responses/:id/cancel
GET  /debug/turns/:id/events
```

Configuration defaults are local and restrictive: host `127.0.0.1`, port `8000`, CORS disabled, state database `.agent-loom/state.sqlite`, approval timeout `60000ms`, cancel timeout `10000ms`, disconnect grace `5000ms`, and event retention disabled unless `AGENT_LOOM_EVENT_RETENTION_DAYS` is set.

To compile a standalone Bun binary:

```bash
bun run package
```
