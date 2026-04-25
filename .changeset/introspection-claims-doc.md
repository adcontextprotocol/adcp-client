---
'@adcp/client': patch
---

`verifyIntrospection`: drop the `as Record<string, unknown>` cast on the
introspection response stored in `AuthPrincipal.claims`. `JWTPayload`'s
`[propName: string]: unknown` index signature already accepts the RFC 7662
response shape structurally, so the cast was hiding the real relationship
between the two types. Adds a JSDoc callout on `AuthPrincipal.claims` that
the field carries either a decoded JWT (verifyBearer) or an RFC 7662
introspection response (verifyIntrospection), and that adapter handlers
passing claim values (`sub`, `username`, `client_id`) into an LLM context
must narrow and validate — an upstream IdP that controls those fields can
inject prompt content otherwise.
