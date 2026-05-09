---
"@adcp/sdk": minor
---

feat(security): SSRF policy gate on buyer-side discovery (adcp-client#1618)

When the SDK auto-detects an agent's protocol (`detectProtocol`) or builds
a `TestClient` for a comply / storyboard run (`createTestClient`), a new
URL-policy gate refuses obvious SSRF targets before any network probe.

**Default policy** (matches the design proposed and greenlit in #1618):

| Range | Default | Why |
|---|---|---|
| Loopback (`127.0.0.0/8`, `::1`, `localhost`) | allow | Local dev loops, mock-server tests, `npm run dev` |
| Cloud metadata (`169.254.169.254`, `fe80::/10`) | always-deny | IMDS exfiltration is never legitimate |
| RFC-1918 / link-local / IPv6 ULA / CGNAT | deny | Internal subnets behind a server-side comply runner |
| Public IPv4/IPv6 | allow | The whole point |

**Single opt-out:** `ADCP_ALLOW_INTERNAL_PROBES=1` widens the default to
allow RFC-1918/link-local/ULA destinations. Read **once at module load** —
no `NODE_ENV` gate (unsafe in multi-tenant staging where `NODE_ENV=test`
images run in production posture). Cloud-metadata addresses stay refused
even with the opt-in.

**IPv4-mapped IPv6 normalization:** `::ffff:169.254.169.254` and
`::ffff:127.0.0.1` are canonicalized via Node's `BlockList` so attackers
can't bypass the policy by choosing a non-standard textual form (URL
parsers canonicalize to binary form `::ffff:a9fe:a9fe`).

**Refusal type:** existing `SsrfRefusedError` (from `src/lib/net/`) with
`code: 'always_blocked_address' | 'private_address'`. User-visible error
text names only the hostname — no resolved IP echo, so refusal logs in
compliance reports don't leak internal network topology.

**Known gap (TOCTOU):** `classifyProbeUrl` is hostname-literal only; a
DNS rebind that resolves `evil.example.com` → `169.254.169.254` between
this gate and `fetch` would slip past. The DNS-pinned `ssrfSafeFetch`
primitive (already used elsewhere in the SDK) covers that vector.
Wiring `detectProtocol` to route through `ssrfSafeFetch` for full
TOCTOU defense is tracked as a follow-up.

**Breaking-ish:** patches existing CLI usage that targets RFC-1918
addresses without setting `ADCP_ALLOW_INTERNAL_PROBES=1`. The dominant
case (CLI against `localhost` or public agents) is unchanged. Minor
bump per semver.
