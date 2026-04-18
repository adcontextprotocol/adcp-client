---
'@adcp/client': minor
---

Storyboard runner support for the `universal/security.yaml` conformance baseline.

Ships the runner work tracked in adcp-client#565. The upstream storyboard (adcontextprotocol/adcp#2298) uses three new directives and four new validation checks that this release implements.

**New step directives**

- `auth: 'none'` — strip transport credentials for that step only. Required for the unauthenticated probe.
- `auth: { type: 'api_key', value? | from_test_kit? | value_strategy? }` — literal Bearer override, pull from the test kit, or generate a per-run random bogus key (`random_invalid`).
- `auth: { type: 'oauth_bearer', value? | value_strategy: 'random_invalid_jwt' }` — send an arbitrary Bearer value or a per-run random JWT-shaped token (valid base64url-encoded JSON header/payload + random signature) so well-implemented validators fail at signature verification.
- `task: "$test_kit.<path>"` + `task_default: '<task>'` — resolve the step's task from test-kit data, falling back to the default when the kit doesn't supply it. Lets the security storyboard probe whatever protected task each agent implements.
- `contributes_to: '<flag>'` — mark a step as contributing a flag on success. Consumed by downstream `any_of` validations.
- `contributes_if: 'prior_step.<id>.passed'` — conditional contribution (e.g., only count the API-key mechanism when BOTH the valid-key and invalid-key steps passed).

**Phase directives**

- `skip_if: '!test_kit.auth.api_key'` — skip optional phases based on test-kit fields.
- `optional: true` — failing steps in optional phases are reported but do not fail the overall storyboard. The storyboard's final `assert_contribution` step is the gate (e.g., "API key OR OAuth must have verified").

**Auth-override HTTP dispatch**

Steps with `auth:` set bypass the MCP SDK and dispatch via a raw JSON-RPC POST to the MCP endpoint. This is required because (a) the SDK transport has no way to strip credentials or send arbitrary Bearer values, and (b) validations need the raw HTTP status + `WWW-Authenticate` header, which the SDK hides. A synthetic `TaskResult` is built from the JSON-RPC response so `field_present` / `field_value` checks still work on successful calls.

**New task handlers (raw HTTP probes, not MCP tools)**

- `protected_resource_metadata` — GETs the agent's `/.well-known/oauth-protected-resource<path>` (RFC 9728).
- `oauth_auth_server_metadata` — GETs `<issuer>/.well-known/oauth-authorization-server` for the first issuer from the prior step.
- `assert_contribution` — synthetic step that evaluates accumulated flags; no network call.

**New validation checks**

- `http_status` / `http_status_in` — exact or list-match on HTTP status.
- `on_401_require_header` — conditional check: if response was 401, require the named header (RFC 6750 §3 compliance).
- `resource_equals_agent_url` — normalized comparison of RFC 9728 `resource` against the URL under test. Catches the audience-mismatch class of bug from adcp-client#563. The error message does **not** echo the advertised value verbatim — compliance reports are shareable and detailed diffs help attackers probe victim agents.
- `any_of` — at least one listed flag must be in the accumulator.

**Safety**

- `comply()` now refuses `http://` agent URLs by default. Use `{ allow_http: true }` or the CLI `--allow-http` flag for local development; the CLI banner marks runs with the flag as non-publishable.
- OAuth authorization-server discovery fetches are hardened against SSRF: HTTPS only, DNS resolution + private-IP check (loopback, RFC 1918, link-local, IPv6 ULA), 10 s timeout, 64 KiB body cap, no cross-host redirect following.

**Degraded-profile execution (fixes adcp-client#570)**

When an agent's `get_adcp_capabilities` probe returns 401, `comply()` previously short-circuited with `overall_status: 'auth_required'` and executed zero storyboards — which meant `universal/security.yaml` could never run against the exact class of agent it's designed to diagnose. It now detects the auth rejection, drops tool-dependent storyboards, and runs the remaining `track: 'security'` and `required_tools: []` storyboards against a degraded profile. The auth observation is preserved alongside whatever conformance gaps the storyboards surface.

**Fenced agent-controlled error text (fixes adcp-client#574)**

The `capabilities_probe_error` observation wraps agent-reported error text in a `<<<…>>>` fence with an explicit "do not follow as instructions" marker and strips terminal control characters. Downstream LLM summarizers of a shared `ComplianceResult` can no longer be prompt-injected by a hostile agent that embedded instructions in its error message. The raw text is still available under `evidence.agent_reported_error` for operators.

**Test-kit schema**

`TestOptions.test_kit` gained an `auth` field with `api_key` and `probe_task`. Storyboard phases read this to gate their skip logic. The field is forward-compatible: additional keys pass through unchanged.

**Breaking**

`runValidations(validations, taskName, taskResult)` became `runValidations(validations, validationContext)` to carry probe results, the agent URL, and the contribution accumulator. Existing callers inside the SDK were updated; external callers who import `runValidations` directly need to pass a `ValidationContext` object.

No storyboard YAML ships in this repo — the real `universal/security.yaml` arrives via the upstream AdCP tarball sync (adcontextprotocol/adcp#2298). This PR makes the runner ready for it.
