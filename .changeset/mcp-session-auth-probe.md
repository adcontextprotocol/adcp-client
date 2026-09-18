---
'@adcp/sdk': patch
---

Fix `security_baseline` reporting `auth_mechanism_verified: []` for MCP agents that serve valid RFC 9728 protected-resource metadata but advertise none of `PROBE_TASK_ALLOWLIST` (adcp-client#2940).

`$test_kit.auth.probe_task` previously resolved to `undefined` for those agents, so every credential probe skipped `not_applicable` and no phase could contribute `auth_mechanism_verified` — a conformant OAuth/PRM orchestrator whose read surface is named `list_plans` / `list_sellers` / `list_creative_status` failed the storyboard, and the required `unauth_rejection` phase was never exercised at all.

`selectProbeTask` now resolves an explicit `mcp_session_probe` sentinel on MCP, and the runner drives a complete MCP session lifecycle through `rawMcpSessionProbe`: `initialize` → `notifications/initialized` → `tools/list` → `DELETE` to terminate the session, over the existing SSRF-bounded raw probe transport. Every parameter is MCP-defined and results are validated against the official `@modelcontextprotocol/sdk` schemas (`InitializeResultSchema`, `ListToolsResultSchema`, `SUPPORTED_PROTOCOL_VERSIONS`). Out-of-allowlist AdCP tools still cannot be probed directly — their parameter surfaces are agent-authored and may 400 before auth runs, which would misreport as an auth failure.

Grading `tools/list` rather than stopping at the handshake is what makes the verdict independent of the agent's enforcement point: an agent that authenticates the Streamable HTTP session is graded on its `initialize` rejection, one that authenticates each operation on its `tools/list` rejection, and a fail-open agent is reported as accepted so its authored `http_status_in` assertion fails. The step's `extraction.note` names the stage the verdict landed on.

The probe primitive — not the authored YAML — owns every fail-closed decision, so a custom or future storyboard cannot talk it into certifying an agent:

- An accepted negative probe (invalid or absent credential completing the lifecycle) is **refused** as auth evidence rather than reported as a rejection.
- A positive probe whose valid credential does **not** complete the protected operation is refused too: there is no successful protected call to certify.
- Responses must correlate — JSON-RPC 2.0 envelope and matching request id — so a non-correlating or notification envelope cannot pass as an acceptance.
- A wire version this SDK does not implement is reported as a **protocol-compatibility** verdict with an SDK-upgrade remedy, never as a credential finding.
- Sessions are terminated on every post-`initialize` exit, including schema-invalid and unsupported-version results that already carry a session id.
- Credentials the probe sent are scrubbed **by value** from the one response that becomes evidence (body, headers and error), covering the case where an agent echoes the `Authorization` header it received into a tool description or a `WWW-Authenticate` parameter — which name-based `redactSecrets` cannot see, and which on a positive probe would publish the run's live credential into `response` and `response_record.payload`.
- Effective credentials and routing are used, not the run's original options: OAuth tokens acquired or refreshed during discovery come from the live agent config, and non-credential tenant/routing headers ride every lifecycle and control request so the probe cannot be answered by a different tenant than the SDK transport uses.
- Every request carries the run's `AbortSignal` and a 5 s cap, bounding a tarpitting agent instead of holding a step for ~80 s.

Fail-closed properties:

- **Valid, invalid and unauthenticated credentials are all exercised.** `auth: none` steps are now graded instead of skipped, so the non-optional `unauth_rejection` phase can no longer stay green while unexercised. Contributing steps additionally run an acceptance control with the run's valid credential: a rejection counts as evidence only when a valid credential completes the same lifecycle on the same endpoint, so an endpoint that refuses everything (down, firewalled, wrong tenant) cannot be certified.
- **Mechanism-matched controls.** The control must be the same _kind_ of credential as the step under test. `oauth_bearer` steps require an OAuth access token (`options.auth.type` of `oauth` / `oauth_client_credentials`); a static API key or Basic credential cannot stand in, so correct PRM plus an unrelated shared secret can no longer launder into `auth_mechanism_verified` — the advertised-but-unserved failure mode the storyboard exists to catch. Within a mechanism, precedence matches `withTestKitAuthDefaults`: explicit `options.auth` wins over the test kit.
- **No control, no certification.** With no credential of the required kind configured, the probe runs (its response is still evidence) and reports `inconclusive` with the remedy, rather than grading the rejection as conclusive.
- **Positive static-credential steps stay `not_applicable`.** `probe_api_key` / `probe_basic` assert an AdCP task response body that no protocol operation produces; grading them from a `tools/list` result would be fabricated evidence. Their `contributes_if: prior_step.<id>.passed` gate therefore stays closed, so the static-credential branches cannot contribute on session evidence alone. Static-credential-only agents with no allowlisted tool remain unverified by design — see the upstream note below.
- **Scoped to MCP.** A2A keeps its existing `undefined` resolution; a storyboard that routes the sentinel onto an A2A run fails the step rather than substituting a handshake.
- **Discovery-unavailable behavior preserved**, and `mcp_session_probe` is absent from `PROBE_TASK_ALLOWLIST` so `test_kit.auth.probe_task` cannot name it.
- Only the sentinel is routed to the runner-native probe path — not any resolved `PROBE_TASKS` member — so a free-form kit field (e.g. `$test_kit.operations.primary_webhook_emitter`) cannot steer a step onto `assert_contribution`'s no-network branch and mint its `contributes_to` flag.
- Credentials are sent but never written back onto results: probe diagnostics use a fixed vocabulary plus runner-produced values (HTTP status, numeric JSON-RPC code), never `error.message`, `protocolVersion`, `serverInfo` or any other agent-supplied string, so an agent that echoes the `Authorization` header it received cannot route the run's valid credential into a compliance report.

Operator-facing output: the ungradable-positive-probe case now has its own `session_probe_ungradable` skip reason whose actionable detail is surfaced in human CLI output and JUnit `<skipped>` messages (previously only the bare reason was), agent-supplied tool names are escaped before entering `skip.detail`, and `MCP_SESSION_PROBE_TASK` is exported from `@adcp/sdk/testing` so report consumers can key on `task` without copying a magic string.

**Upstream follow-up:** making the static-credential branches verifiable for no-allowlist agents needs a session-layer positive step in the `security_baseline` storyboard itself (`adcontextprotocol/adcp`), not an SDK-side reinterpretation of its existing assertions.
