---
'@adcp/sdk': minor
---

**CLI: `-H` / `--header KEY=VALUE` flag for arbitrary outbound HTTP headers** (closes adcp-client#1563).

`npx adcp` previously accepted `--auth TOKEN` but had no way to attach the routing/context headers that multi-tenant agents require alongside the bearer. Verify scripts couldn't reach a freshly-provisioned tenant on `http://localhost:8000` because strategy 1 (Host-header → virtual host) falls through on `localhost`, leaving strategy 2 (`x-adcp-tenant`) the only option — and the CLI couldn't send it.

The flag is repeatable, persists via `--save-auth`, and composes with every existing auth method:

```sh
# Ad-hoc invocation
npx adcp http://localhost:8000/mcp/ get_products '{...}' \
  --auth TOKEN \
  -H x-adcp-tenant=acme \
  -H Apx-Incoming-Host=tenant-acme.example.com

# Persist on the saved alias
npx adcp --save-auth tenant-acme http://localhost:8000/mcp/ \
  --auth TOKEN \
  -H x-adcp-tenant=acme

# Saved headers flow through every subsequent invocation, including storyboard runs
npx adcp tenant-acme storyboard run media_buy_seller
```

`Authorization` and `x-adcp-auth` are reserved — `--auth` always wins on conflict. Custom values for those keys are dropped with a stderr warning rather than silently overriding the bearer (acceptance criterion #3 from the issue).

Saved headers display as NAMES only in `--list-agents` (mirrors the redaction posture for `oauth_client_credentials`); values may carry tenant-routing tokens.

Plumbing details:

- `parseHeaderFlags(args)` (in `bin/adcp.js`) is the shared parser — used by the main one-shot tool call, `--save-auth`, and `parseAgentOptions` (so `storyboard run` and the capability-driven assessment also pick up CLI-supplied headers and merge with the saved alias).
- `AgentConfig.headers` already existed in the SDK and is plumbed end-to-end through both MCP and A2A transports (`src/lib/protocols/{mcp,a2a}.ts`, `src/lib/core/SingleAgentClient.ts`); the change is purely CLI/config wiring on top.
- `TestOptions.headers` added so storyboard runs honor saved/CLI headers via `createTestClient` → `agentConfig.headers`. Composes with `auth.basic` (Basic auth still wins on Authorization).
- Acceptance criteria from the issue:
  - ✅ `-H K=V` works for ad-hoc invocations (repeatable; both `-H` and `--header`, plus `--header=K=V`).
  - ✅ Per-agent `headers` field in `~/.adcp/config.json` is honored.
  - ✅ Auth wins on conflict (Authorization / x-adcp-auth dropped with warning).

Companion gap in the Python SDK (`uvx adcp` and `AgentConfig.headers`) is tracked separately in `adcontextprotocol/adcp-client-python`.
