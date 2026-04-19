---
'@adcp/client': patch
---

Lift the SSRF-safe fetch used by the storyboard runner into a reusable
`@adcp/client/net` primitive. Behavior is unchanged for metadata probes;
raw MCP probes now dispatch through the DNS-pinned undici `Agent` that was
previously only used for metadata fetches — closes a TOCTOU gap where an
attacker-supplied agent URL could resolve to a public IP during SSRF
validation and a private IP during the actual connect.

Tightened defaults:

- `rawMcpProbe` now refuses `http://` / private-IP agent URLs unless the
  caller passes `allowPrivateIp: true`. The storyboard runner threads
  `allow_http` through, so dev loops against localhost agents keep
  working end-to-end.
- IMDS (`169.254.169.254`, IPv6 `fe80::/10`) stays refused even under
  `allowPrivateIp` — cloud metadata exfiltration is never a legitimate
  dev-loop destination.

New exports (internal; the public barrel is unchanged):

- `ssrfSafeFetch(url, options)` — returns buffered bytes + headers; throws
  `SsrfRefusedError` with a typed `code` when the guard refuses.
- `SsrfRefusedError`, `SsrfRefusedCode`, `SsrfFetchOptions`,
  `SsrfFetchResult`.
- `isPrivateIp`, `isAlwaysBlocked` (moved from
  `src/lib/testing/storyboard/probes.ts`; the original import site keeps
  working via re-export).
- `decodeBodyAsJsonOrText(body, contentType)` — convenience decoder for
  probe-style call sites.

The primitive is the foundation for future HTTPS-fetching stores (JWKS
auto-refresh, revocation-list polling) that must not follow counterparty
URLs into private networks.
