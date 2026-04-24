---
'@adcp/client': minor
---

feat(server): host-aware `serve()` for one-process multi-host deployments

`ServeOptions.publicUrl` and `protectedResource` now accept a `(host) => …`
function, and the factory's `ServeContext` carries the resolved `host` so one
process can front many hostnames (white-label sellers, multi-brand adapters)
without re-owning the HTTP plumbing. Set `trustForwardedHost: true` when
`serve()` sits behind a proxy that sanitizes `X-Forwarded-Host`. Per-host
resolver results are cached. Static `publicUrl: string` is unchanged.

`verifyBearer({ audience })` now also accepts `(req) => string` so the JWT
audience check follows the per-host `publicUrl` — a token minted for
`snap.example.com` fails audience validation when presented to `meta.example.com`.

Closes #885.
