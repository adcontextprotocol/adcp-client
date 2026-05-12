---
'@adcp/sdk': patch
---

docs(signing): note that Authorization is not in SIGNING_RESERVED_HEADERS (closes #1725)

Add a block comment to `src/lib/signing/fetch.ts` (and the mirrored line in
`fetch-async.ts`) explaining that `authorization` is intentionally NOT in
`SIGNING_RESERVED_HEADERS`. AdCP's RFC 9421 profile doesn't cover the
`Authorization` header (see `MANDATORY_COMPONENTS` in
`src/lib/signing/types.ts`), so caller-supplied Bearer / RFC 7617 Basic
headers pass through `createSigningFetch` unmodified.

Surfaces two latent gotchas in the comment so future contributors don't
have to rediscover them:

1. If a future AdCP profile adds `authorization` to `covered_components`,
   the canonicalizer must read the FINAL outgoing value (post-`mergeHeaders`
   injection in `bin/adcp.js` for the CLI Basic-auth path landed in #1719).
   `createSigningFetch` already reads `init.headers` at fetch time so the
   architecture survives this — the comment makes that explicit.

2. RFC 9421 §7.5.7 warns about signing over long-lived credentials. Basic
   credentials don't rotate, so signing over them creates a re-attack
   surface. Any future `covers_authorization` policy knob needs that
   security consideration in scope.

Comment-only change. No code, test, or behavior impact. Source: protocol-
expert review of #1719.
