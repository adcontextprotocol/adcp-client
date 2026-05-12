---
'@adcp/sdk': patch
---

fix(protocols): MCP/A2A connection cache key disambiguates non-Bearer credentials (closes #1723 / Security L1)

Both protocol caches keyed on `agentUrl + hash(authToken)`. When the caller
used a non-Bearer scheme — RFC 7617 Basic from the CLI's `--auth-scheme
basic` shape landed in #1719, or any future caller-injected
`Authorization` header — `authToken` was undefined and the cache key
collapsed to just `agentUrl + signingCacheKey`. Two callers with
different `user:pass` credentials targeting the same agent URL would
silently share a single cached MCP/A2A transport, and the transport
closed over whichever credential it saw first.

For the single-process CLI this was a non-issue (process boundary
isolates credentials). But the SDK is also consumed by long-lived
multi-tenant hosts (`createTestClient`-fronted services serving N
principals), and there a credential cross-leak across the connection
boundary is a real bug — `tenant-A`'s next call could ride
`tenant-B`'s transport.

**Fix**: when `authToken` is unset, both `connectionCacheKey` (MCP) and
`a2aCacheKey` (A2A) now derive the cache fingerprint from the
`Authorization` header on the outgoing request (case-insensitive
lookup, since header keys vary by call site). The hash prefix
(`createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)`)
stays byte-equivalent with the bearer path so existing cache entries
work unchanged, and same-credential callers still share a single
cached transport — the key only changes when the credential differs.

A new helper `extractAuthHeader` (mirrored on both protocols, kept
private to each module so they don't share a runtime import) does the
case-insensitive lookup.

A2A also gets the same fix at the eviction site (`is401Error` cache
delete) so a 401 on a non-Bearer call evicts the right entry instead
of the bearer-keyed entry.

Tests: `test/lib/mcp-connection-cache-basic-auth.test.js` spins up a
local minimal MCP server, calls it twice with different
`Authorization: Basic …` headers via `callMCPTool`, and asserts BOTH
credentials reach the wire. The pre-fix shape (cache key matches on
just `agentUrl`) fails the first assertion — only tenant-A's
credential ever reaches the wire because tenant-B's call gets a cache
hit on tenant-A's transport. Second test asserts no cross-test
contamination (same-credential calls don't leak prior-test
credentials into the same connection).

47/47 cross-suite regression passing (cli-auth-scheme +
cli-header-flag + cli-oauth-flag + authentication-required-error +
probe-auth-challenge + mcp-connection-cache-basic-auth).

Source: security-reviewer L1 from PR #1719 follow-up.
