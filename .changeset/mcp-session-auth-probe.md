---
'@adcp/sdk': minor
---

Fix `security_baseline` reporting `auth_mechanism_verified: []` for MCP agents that advertise none of `PROBE_TASK_ALLOWLIST` (adcp-client#2940).

`$test_kit.auth.probe_task` resolved to `undefined` for those agents, so every credential probe skipped `not_applicable`, no phase could contribute `auth_mechanism_verified`, and the **required** `unauth_rejection` phase was never exercised either.

## What adopters see

- **A new `mcp_session_probe` task appears in reports** when your read surface is outside the allowlist. It is not an AdCP tool; it is the runner calling a protected tool of yours through the official MCP SDK client.
- **A new skip reason, `session_probe_ungradable`** (canonical `not_applicable`), rendered by the CLI as `Skipped (not_applicable / session_probe_ungradable)` followed by an actionable `Skipped:` detail line, and in **JUnit** as `<skipped message="session_probe_ungradable: …"/>` — per-step skip messages now carry the runner's detail, XML 1.0-sanitised.
- **`MCP_SESSION_PROBE_TASK` is exported from `@adcp/sdk/testing`** so report consumers key on a constant rather than a magic string.
- **Diagnostics are distinguishable**: `is inconclusive` (nothing was proved), `refuses this as auth evidence` (you are fail-open, or a valid credential failed), and `could not run` (a protocol/wire-version/response-shape problem that says nothing about credentials).
- **If you advertise no read-shaped auth-required tool, auth cannot be certified.** Advertise one allowlisted read tool — see `skills/cross-cutting.md` § "Advertise one allowlisted read tool".

## How it works

`selectProbeTask` resolves the sentinel only on an explicit `protocol: 'mcp'`, and the runner selects a **protected tool** from the agent's advertised tools: read-shaped (`list_*` / `get_*`), never a mutating task, never public-tier (`get_adcp_capabilities`, `get_products`, `list_creative_formats`). None available ⇒ `session_probe_ungradable`.

The lifecycle is the official `@modelcontextprotocol/sdk` client throughout — `Client.connect()`, `Client.callTool(target, {})`, `StreamableHTTPClientTransport.terminateSession()` — so response-id correlation, result-schema validation and version negotiation are the SDK's. `tools/list` is never issued by the probe and never enters graded evidence: MCP discovery is not an AdCP protected task. Raw status and `WWW-Authenticate` come from two SDK-supported seams: the transport's `fetch` option (carrying the repo's SSRF-guarded `createAgentTransportFetch`) and `withRawResponseCapture`.

Evidence rules, all enforced in the probe primitive rather than the authored YAML:

- **Rejection** = 401/403 at `initialize` or the protected call, or an operation-level AdCP `AUTH_MISSING` / `AUTH_INVALID` inside a successful MCP envelope. (`security_baseline` still grades `http_status_in`, so an agent signalling auth only that way needs the upstream storyboard contract to widen.)
- **Fail-open** = a successful tenant-scoped payload for a bad or absent credential.
- **Inconclusive** = a schema/param refusal (`INVALID_REQUEST`), or no mechanism-matched valid credential to control against. Never a pass or a fail.
- **Controls are mechanism-matched and use the same target.** `oauth_bearer` requires an OAuth access token — a static key cannot certify the OAuth branch. A successful payload _or_ a non-auth schema refusal proves the endpoint does not refuse everything; an auth rejection of the valid credential makes the result inconclusive.

Hardening: a streaming response-body cap that applies to SSE and aborts the request (the shared size-limit wrapper is inert without its ALS scope and exempts SSE); the run `AbortSignal` and a bounded per-request deadline applied at the fetch boundary so a withheld `notifications/initialized` response cannot hang a run; credential scrubbing by value across body, headers and error — including decoded Basic `user:password`, the password alone, and short tokens — failing closed at its traversal limits; routing headers derived from what the transport actually sends, excluding credential-carrying names and any header whose value matches a run credential, so `x-routing-key` / `x-partition-key` survive; OAuth tokens read from the live agent config so a token acquired or refreshed during discovery is used; and session termination on every post-`initialize` exit, carrying the negotiated protocol version.

**Upstream follow-up:** making the static-credential branches verifiable for no-allowlist agents, and letting `security_baseline` accept an operation-level auth refusal, both need changes to the storyboard contract in the `adcontextprotocol/adcp` spec repo rather than SDK-side reinterpretation.
