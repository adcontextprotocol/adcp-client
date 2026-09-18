---
'@adcp/sdk': minor
---

Verify MCP auth for agents that advertise none of `PROBE_TASK_ALLOWLIST`, and say so honestly when it cannot be verified (adcp-client#2940).

`$test_kit.auth.probe_task` resolved to `undefined` for those agents, so every credential probe skipped `not_applicable`, no phase could contribute `auth_mechanism_verified`, and the **required** `unauth_rejection` phase was never exercised either.

## Which agents this fixes, and which it only explains

The runner now falls back to a `mcp_session_probe` sentinel that calls a **canonical AdCP read task** the agent advertises — parameter-free, never public-tier, never mutating. Two outcomes:

- **Agent advertises a canonical protected read outside the allowlist** (`get_principal`, `list_tasks`, `list_transformers`, `get_plan_audit_logs`, …) ⇒ auth is now verified through it, and `security_baseline` contributes `auth_mechanism_verified` instead of reporting `[]`.
- **Agent advertises only its own non-AdCP tool names** — the shape in the original #2940 report ⇒ the step is **explicitly `session_probe_ungradable`** with an adopter remedy, not certified. Only canonical AdCP tasks are eligible: an agent that named a tool `get_probe_target`, enforced credentials on that one, and left the real surface open would otherwise be certified by its own vocabulary. Remedy: advertise one allowlisted read tool, or serve RFC 9728 metadata and run with `--oauth`.

What the probe establishes is bounded: the agent enforced its auth mechanism **at the tool that was graded**. It is not a claim that every tool enforces auth, and it verifies no cryptographic property of the credential or its issuer.

## What adopters see

- **A new `mcp_session_probe` task in reports** when your read surface is outside the allowlist. It is not an AdCP tool; it is the runner calling a protected tool of yours through the official MCP SDK client. The step note records which tool was graded — `MCP session probe graded get_principal at tools/call (HTTP 401)`.
- **A new skip reason, `session_probe_ungradable`** (canonical `not_applicable`). The CLI prints `   Skipped (not_applicable / session_probe_ungradable)` followed by the runner's detail on its own line, and JUnit emits `<skipped message="session_probe_ungradable: …"/>` — runner-authored skip messages now carry that detail, length-capped and XML 1.0-sanitised.
- **`MCP_SESSION_PROBE_TASK` is exported from `@adcp/sdk/testing`** so report consumers key on a constant rather than a magic string.
- **Diagnostics are distinguishable**: `is inconclusive` (nothing was proved), `refuses this as auth evidence` (you are fail-open, or a valid credential failed), and `could not run` (a protocol/wire-version/response-shape problem that says nothing about credentials).
- **Every remedy names the same eight tools**, rendered from one constant, so the probe's diagnostic, the runner's skip detail and the docs cannot drift. See `skills/cross-cutting.md` § "Advertise one allowlisted read tool".

## How it works

`selectProbeTask` resolves the sentinel only on an explicit `protocol: 'mcp'`; `comply()` normalises an unset transport to `mcp` at its entry boundary, which is the transport it has always used on the wire. A storyboard that names the sentinel directly on a run with no declared transport is refused rather than served MCP.

Target selection is **runner-ordered**, never the agent's advertisement order: allowlisted tools first (allowlist order), then canonical parameter-free reads with `get_principal` preferred. A shape refusal on the first target retries the next candidate; if all refuse the shape, the step is inconclusive rather than graded.

The lifecycle is the official `@modelcontextprotocol/sdk` client throughout — `Client.connect()`, `Client.callTool(target, {})`, `StreamableHTTPClientTransport.terminateSession()` — so response-id correlation, result-schema validation and version negotiation are the SDK's. `tools/list` is never graded evidence: MCP discovery is not an AdCP protected task. Raw status and `WWW-Authenticate` come from two SDK-supported seams: the transport's `fetch` option (carrying the repo's SSRF-guarded `createAgentTransportFetch`) and `withRawResponseCapture`.

Evidence rules, all enforced in the probe primitive rather than the authored YAML:

- **Rejection** = 401/403 at `initialize` or the protected call, or an AdCP `AUTH_MISSING` / `AUTH_INVALID` / `AUTH_REQUIRED` code in a recognised error envelope. A bare 400 is _not_ a rejection unless it carries `WWW-Authenticate` or one of those codes — otherwise a parameter complaint would certify an agent that never read the credential.
- **Fail-open** = a successful tenant-scoped payload for a bad or absent credential.
- **Inconclusive** = a schema/param refusal (`INVALID_REQUEST` / JSON-RPC `-32602`), a bare `isError: true` with no recognised code, or no mechanism-matched valid credential to control against. Never a pass or a fail.
- **Controls are mechanism-matched and use the same target.** `oauth_bearer` requires an OAuth access token — a static key cannot certify the OAuth branch. The control sends both `Authorization: Bearer` and `x-adcp-auth`, matching `createMCPAuthHeaders`; `auth: none` sends neither.
- **Signed runs fail closed.** When the run signs functional dispatch and the agent declares the probe's only targets under `request_signing.required_for` / `supported_for`, the step is `session_probe_ungradable`: the probe mints no RFC 9421 signatures, and a signature refusal is not a credential verdict.

Hardening: a streaming response-body cap that applies to SSE and aborts the request; `reconnectionOptions.maxRetries: 0` on both transports plus opt-in capture count/byte ceilings on `withRawResponseCapture`, so a hostile `retry: 0` SSE stream cannot amplify one probe into thousands of requests (overflow marks the result unusable rather than truncating evidence silently); the run `AbortSignal` and a bounded per-request deadline applied at the fetch boundary; session termination detached from a cancelled run signal so an aborted run still sends exactly one DELETE with the session id and negotiated protocol version; credential scrubbing by value across body, headers and error — including decoded Basic `user:password`, the password alone, short tokens and `options.headers` values — failing closed at its traversal limits; routing headers derived from what the transport actually sends, with an unclassifiable header failing the step rather than being silently forwarded or dropped; and OAuth tokens read from the live agent config, only when that config's `agent_uri` is the agent under test.

**Upstream follow-up (adcp-client#2940 stays open):** certifying the static-credential branches for a no-allowlist agent, and letting `security_baseline` accept an operation-level auth refusal, both need changes to the storyboard contract in the `adcontextprotocol/adcp` spec repo rather than SDK-side reinterpretation.
