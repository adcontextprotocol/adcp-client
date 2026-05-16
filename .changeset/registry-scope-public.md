---
'@adcp/sdk': patch
---

feat(registry): add `scope` narrowing filter to `lookupOperator` (#1769, adcp#4581)

`RegistryClient.lookupOperator(domain, opts?)` now accepts an optional `{ scope?: 'public' | 'member' | 'private' | 'all' }` argument that maps 1:1 to the server's `?scope=` query param. `scope` is a **narrowing filter** — it never widens the view beyond what the caller's auth would otherwise return.

- `'public'` — only `visibility=public`. Anonymous-equivalent view; useful for pre-sign-in pickers driven by an admin-tier API key whose only purpose is rate-limit + audit attribution.
- `'member'` — public + `members_only`. `members_only` requires API tier; anonymous / explorer-tier callers silently fall through to public-only (no 403). Note: the bucket name `'member'` is distinct from the underlying `visibility: 'members_only'` enum literal.
- `'private'` — only `visibility=private`. Profile-owner only; non-owners get an empty agents array rather than 403.
- omitted / `'all'` — tier-aware union (public + members_only when authorized + owner's private). Preserves historical behavior.

Older AAO servers that predate this enum will silently ignore unknown `?scope=` values and return the historical tier-aware union, so passing `'public'` against an older server does NOT enforce the public-only view client-side.

`lookupPublisher` does not accept `scope`: the spec's PR (adcp#4581) widens only `/api/registry/operator`, and the publisher endpoint has no visibility-tier semantics today. The option will be added in lockstep with a spec PR if and when publisher visibility filtering lands.
