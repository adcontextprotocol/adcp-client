---
---

test(discovery): migrate `network-consistency-checker.test.js` and
`property-crawler.test.js` off `globalThis.fetch` mocks onto real
loopback HTTP servers (closes adcp-client#1637, follow-up to #1633).

Test-only change — no library behavior is modified. After #1633 routed
discovery code through `ssrfSafeFetch` (which uses undici directly and
bypasses `globalThis.fetch` monkey-patches), the existing mocks no
longer exercised the production path. The migrated tests mirror the
`protocol-detection-1612.test.js` / `discovery-ssrf-policy.test.js`
pattern: `http.createServer` on `127.0.0.1` with
`ADCP_ALLOW_INTERNAL_PROBES=1`. 44/44 tests pass against the real
production code path.
