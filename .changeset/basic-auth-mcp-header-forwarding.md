---
'@adcp/sdk': patch
---

fix(mcp): forward header-only auth (basic, x-api-key) through `SingleAgentClient` precheck path

Basic-auth (and any header-only auth) MCP agents were silently broken via `SingleAgentClient.executeTask` — every public entry point that wraps it (`getAdcpCapabilities`, `executeTaskWithSchema`, the CLI, direct tool calls) ran a `getCapabilities` precheck that dropped the `Authorization` header on the floor. The agent received an unauthenticated request, returned its anonymous response (or 401), and the SDK either errored out or surfaced the anonymous payload as the agent's real state. Curl with the same credentials returned 200; the SDK did not.

Two compounding defects, both required for a fix:

- `SingleAgentClient.getAgentInfo` did not forward `normalizedAgent.headers` to `connectMCP`. Basic auth intentionally suppresses `auth_token` (so the SDK doesn't emit a competing `Authorization: Bearer …`) and lives entirely on `headers.Authorization` — neither the `oauth_tokens` nor the `auth_token` branch fired, so `connectMCP` received `{ agentUrl }` only.
- `connectMCP` only attached `requestInit.headers` inside the `else if (authToken)` branch. Header-only auth (no token) was dropped even when `customHeaders` was supplied.

Both branches are fixed: `getAgentInfo` now forwards `headers` as `customHeaders`, and `connectMCP` builds `requestInit.headers` whenever any headers are present — including alongside `authProvider`, so OAuth users with custom routing/tenant headers benefit too.

**Precedence note:** the MCP SDK's `_commonHeaders()` spreads `requestInit.headers` **over** any provider-emitted `Authorization` (`new Headers({ ...providerHeaders, ...requestInitHeaders })` — last-write-wins). To prevent a caller-supplied `Authorization` in `customHeaders` from silently overriding the OAuth bearer, `connectMCP` now strips `Authorization` from `customHeaders` when `authProvider` is set. Non-auth headers (routing, tenant ID, x-api-key co-tokens) still flow through. The bearer-token branch is unaffected — its own merge already lays the bearer last, so static `auth_token` takes precedence over any stray `customHeaders.Authorization` (regression test asserts this).

Also fixes the cosmetic `adcp storyboard run` banner that labeled basic auth as `"bearer"` (`bin/adcp.js` chained-ternary fell through when `authOption.type === 'basic'`).

Regression test at `test/lib/get-agent-info-basic-auth.test.js` stands up a loopback MCP server that 401s without `Authorization: Basic`, then asserts every request the SDK makes (including the `tools/list` precheck) carries the header. Closes #1864 and #1865.
