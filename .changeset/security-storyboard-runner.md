---
'@adcp/client': minor
---

Storyboard runner support for the `universal/security.yaml` conformance baseline.

Ships the runner work tracked in adcp-client#565. The upstream storyboard (adcontextprotocol/adcp#2298) uses three new directives and four new validation checks that this release implements.

**New step directives**

- `auth: 'none'` — strip transport credentials for that step only. Required for the unauthenticated probe.
- `auth: { type: 'api_key', value?, from_test_kit? }` — literal Bearer override or pull from the test kit. Supports invalid-key probes and the valid-key probe.
- `contributes_to: '<flag>'` — mark a step as contributing a flag on success. Consumed by downstream `any_of` validations.
- `contributes_if: 'prior_step.<id>.passed'` — conditional contribution (e.g., only count the API-key mechanism when BOTH the valid-key and invalid-key steps passed).

**Phase directive**

- `skip_if: '!test_kit.auth.api_key'` — skip optional phases based on test-kit fields.

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

**Test-kit schema**

`TestOptions.test_kit` gained an `auth` field with `api_key` and `probe_task`. Storyboard phases read this to gate their skip logic. The field is forward-compatible: additional keys pass through unchanged.

**Breaking**

`runValidations(validations, taskName, taskResult)` became `runValidations(validations, validationContext)` to carry probe results, the agent URL, and the contribution accumulator. Existing callers inside the SDK were updated; external callers who import `runValidations` directly need to pass a `ValidationContext` object.

No storyboard YAML ships in this repo — the real `universal/security.yaml` arrives via the upstream AdCP tarball sync (adcontextprotocol/adcp#2298). This PR makes the runner ready for it.
