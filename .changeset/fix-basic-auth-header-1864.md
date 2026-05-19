---
"@adcp/sdk": patch
---

fix(client): forward custom headers to connectMCP on getAgentInfo path

Basic-auth MCP agents were completely broken via `SingleAgentClient.executeTask`.
Two cooperating defects caused the `Authorization: Basic …` header to be silently
dropped on the `getCapabilities()` precheck that every `executeTask` invocation
runs before dispatching the actual tool call:

**Defect A** (`SingleAgentClient.getAgentInfo`): `connectOptions` was built
without `this.normalizedAgent.headers`, so `connectMCP` received `{ agentUrl }`
only when neither OAuth nor a bearer token was present. Fixed by always forwarding
`normalizedAgent.headers` as `customHeaders`.

**Defect B** (`connectMCP`): the `transportOptions.requestInit.headers` assignment
was nested inside `else if (authToken)`, so caller-supplied `customHeaders` were
silently dropped whenever `authToken` was absent. Fixed by computing `authHeaders`
unconditionally (merging with token headers when present) and setting
`requestInit` whenever the result is non-empty. As a bonus, `authProvider` is no
longer exclusive with `requestInit.headers` — OAuth callers with custom routing
headers (x-tenant-id, x-api-key, etc.) now get them forwarded too.

Fixes #1864.
