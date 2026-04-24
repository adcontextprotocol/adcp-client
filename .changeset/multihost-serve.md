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

New `resolveHost(req, { trustForwardedHost? })` and `hostname(host)` exports
— same logic `serve()` uses internally, so callers building their own
host-dispatch middleware behind `createExpressAdapter` don't re-implement the
X-Forwarded-Host / RFC 7239 Forwarded / overwrite-vs-append hardening.

New `reuseAgent: true` on `ServeOptions` — lets the factory cache
`AdcpServer` instances per host instead of reconstructing on every request.
The framework wraps connect→handleRequest→close in a per-instance async
mutex because MCP's `Protocol.connect()` rejects when a transport is
already attached. Concurrent requests on different cached servers still
run in parallel. Closes #901.

New `verifyIntrospection({ introspectionUrl, clientId, clientSecret, … })`
authenticator — RFC 7662 bearer validation for adapter agents that proxy
upstream platform OAuth (Snap, Meta, TikTok, …) rather than minting their
own JWTs. Matches `verifyBearer`'s shape (`null` on missing bearer, throws
`AuthError` on reject). Features: TTL-capped positive cache keyed on SHA-256
of the token, opt-in negative caching, RFC 6749 §2.3.1 form-urlencoded Basic
auth, fail-closed on upstream errors/timeouts, optional `requiredScopes` and
`audience` checks. Closes #902.

Closes #885.
