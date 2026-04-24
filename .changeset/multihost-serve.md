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

`verifyBearer({ audience })` now also accepts `(req, ctx) => string` where
`ctx = { host, publicUrl }` comes from `serve()`'s host resolution — use
`audience: (_req, { publicUrl }) => publicUrl!` so the JWT audience check
and the RFC 9728 `resource` URL can never diverge. Reading `X-Forwarded-Host`
directly in the callback is a footgun when `trustForwardedHost` is off.

New `UnknownHostError` class — throw it from the factory (or `publicUrl`/
`protectedResource` resolvers) for unconfigured hosts; `serve()` maps to
404 with a generic body so the routing table never crosses the wire.

New `getServeRequestContext(req)` helper exposes the resolved
`{ host, publicUrl }` to custom authenticators wired outside `verifyBearer`.

Closes #885.
