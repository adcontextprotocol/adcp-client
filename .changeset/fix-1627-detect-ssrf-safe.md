---
"@adcp/sdk": patch
---

fix(security): route detectProtocol through ssrfSafeFetch for DNS-pin / TOCTOU defense (adcp-client#1627)

Closes the TOCTOU rebind window left open in #1618's hostname-literal gate.
Before this change, `detectProtocol` used native `fetch`, which performs
its own DNS lookup at connect time — a hostname like `evil.example.com`
that resolves to `169.254.169.254` would slip past the literal-IP gate
and reach IMDS regardless. Native fetch also auto-followed `Location:`
headers, so a 302 to an internal URL would bounce through the SSRF
defense.

`detectA2AOrMcp` now routes the well-known card probe through
`ssrfSafeFetch`, which:

- resolves DNS once,
- validates the full address set against `address-guards`,
- pins the connect to the first validated address via undici's
  `Agent.connect.lookup` (defeats rebind between validation and connect),
- sets `redirect: 'manual'` so a 302 to an internal URL is not followed,
- caps the response body at 4 KiB (the agent card is small; tightens the
  malicious-slow-body window).

The hostname-literal `classifyProbeUrl` gate from #1618 stays in place
as cheap synchronous defense in depth.

**SSRF-error classification preserved:** policy refusals
(`always_blocked_address`, `private_address`, `body_exceeds_limit`,
`scheme_not_allowed`, `non_https_without_opt_in`, `invalid_url`)
propagate to the caller — silently converting them to `suspect = true`
would reintroduce the catch-swallow class. DNS conditions
(`dns_lookup_failed`, `dns_empty`) fall through to suspect, matching the
pre-#1627 behavior so CLI tests that use `*.example.invalid` keep
exiting with the existing CLI exit codes.

**Test migration:** the existing classification tests moved from
`globalThis.fetch` mocks to real loopback HTTP servers (matches the
`net-ssrf-fetch.test.js` pattern). New `protocol-detection-toctou.test.js`
adds explicit DNS-pin defense assertions: IMDS literal refusal,
IPv4-mapped IPv6 IMDS, IPv6 link-local, catch-swallow regression guard,
and confirmation that 302 `Location:` headers are not auto-followed.

**No API change.** Default behavior on public hosts is unchanged.
Behavior on `http://` URLs is now refused without
`ADCP_ALLOW_INTERNAL_PROBES=1` (matches `ssrfSafeFetch`'s scheme guard).
Compliance runs against bare-`http://` agents need the env opt-in
(operator-only) — production AdCP agents must terminate TLS per spec.
