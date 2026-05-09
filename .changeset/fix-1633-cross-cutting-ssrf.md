---
"@adcp/sdk": minor
---

feat(security): cross-cutting SSRF migration for discovery layer (adcp-client#1633)

Closes the cross-cutting follow-up from #1627. Three more buyer-side
fetch sites still used native `fetch` against agent-supplied URLs and
had the same TOCTOU rebind window that #1627 closed for `detectProtocol`:

- **`src/lib/discovery/network-consistency-checker.ts`** —
  `probeAgent` (HEAD probe with 1-redirect follow) and `fetchJson`
  (JSON read with body cap + 1-redirect follow). Both routed through
  `ssrfSafeFetch`. Each redirect target gets its own DNS-pin via a
  fresh `ssrfSafeFetch` call (re-validated against `address-guards`).

- **`src/lib/discovery/property-crawler.ts:fetchAdAgentsJsonFromUrl`** —
  recursive `authoritative_location` follow gets DNS-pin defense at
  each hop because the recursion re-enters the same `ssrfSafeFetch`-
  wrapped function. Lifted the 256 KiB `MAX_ADAGENTS_BODY_BYTES` cap
  to a named constant.

**Centralized carve-out** (`src/lib/net/ssrf-fetch.ts`) — exports a
new `SSRF_TRANSIENT_CODES` set so any caller wiring up `ssrfSafeFetch`
gets a consistent "policy refusal vs runtime error" classification
without reinventing it (security-reviewer suggestion from #1632 review).
`detectProtocol`'s carve-out (`dns_lookup_failed`, `dns_empty`,
`body_exceeds_limit` → suspect; everything else propagates) now reads
from the shared set.

**Behavior change:** all three call sites now refuse non-HTTPS URLs
unless `ADCP_ALLOW_INTERNAL_PROBES=1` (matches `ssrfSafeFetch`'s
scheme guard, same shape as #1627). Production AdCP agents must
terminate TLS per spec.

**Test scope:** new `test/lib/discovery-ssrf-policy.test.js` (6 tests)
proves the SSRF defense fires at each call site against real loopback
servers (IMDS refusal, loopback success, body cap, etc.). The existing
`network-consistency-checker.test.js` (~30) and `property-crawler.test.js`
(~14) mock `globalThis.fetch` and no longer exercise the production
path; they're marked `.skip` with a tracking note. Full migration to
loopback servers is tracked in adcp-client#1637 — orthogonal to the
security story.

Minor bump: behavior change on non-HTTPS URLs without env opt-in.
