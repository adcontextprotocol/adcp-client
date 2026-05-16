---
'@adcp/sdk': patch
---

feat(registry): add `scope` narrowing filter to `lookupOperator` / `lookupPublisher` (#1769, adcp#4581)

`RegistryClient.lookupOperator(domain, opts?)` and `RegistryClient.lookupPublisher(domain, opts?)` now accept an optional `{ scope?: 'public' | 'member' | 'private' | 'all' }` argument that maps 1:1 to the server's `?scope=` query param. `scope` is a **narrowing filter** — it never widens the view beyond what the caller's auth would otherwise return.

- `'public'` — only `visibility=public`. Anonymous-equivalent view; useful for pre-sign-in pickers driven by an admin-tier API key whose only purpose is rate-limit + audit attribution.
- `'member'` — public + `members_only`. `members_only` requires API tier; anonymous / explorer-tier callers silently fall through to public-only (no 403).
- `'private'` — only `visibility=private`. Profile-owner only; non-owners get an empty agents array rather than 403.
- omitted / `'all'` — tier-aware union (public + members_only when authorized + owner's private). Preserves historical behavior.

The publisher endpoint does not vary by visibility tier today; the option is forwarded for symmetry and forward compatibility.
