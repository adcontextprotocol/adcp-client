---
"@adcp/sdk": minor
---

BuyerAgentRegistry: surface authenticator-stamped `extra` to `resolveByCredential` (issue #1484)

`BuyerAgentRegistry.bearerOnly` and `.mixed` now forward `authInfo.extra` as a second
optional argument to `resolveByCredential`. Adopters using prefix-based bearer conventions
(e.g. demo tokens, tenant-encoded keys) can stamp extension data in their `verifyApiKey.verify`
callback and recover it in the resolver without a pre-registered hash lookup.

`attachAuthInfo` in `serve.ts` is also updated to propagate `principal.extra` from the
`AuthPrincipal` returned by `authenticate()` into `info.extra`, closing the forwarding gap
at the authenticator boundary.

`ResolveBuyerAgentByCredential` gains an optional second parameter
`extra?: Record<string, unknown>`. Existing single-argument implementations continue to
satisfy the widened type without changes.
