---
'@adcp/sdk': patch
---

feat(registry): add `scope=public` option to `lookupOperator` / `lookupPublisher` (#1769)

`RegistryClient.lookupOperator(domain, opts?)` and `RegistryClient.lookupPublisher(domain, opts?)` now accept an optional `{ scope?: 'public' | 'all' }` argument. When `scope: 'public'` is passed, the client appends `?scope=public` so the AAO server returns the anonymous-equivalent view regardless of the caller's API tier — useful for platform integrations using an admin-scoped key that want to render a public picker.

Default behavior (no opts, or `scope: 'all'`) is unchanged: the server honors the caller's tier and includes `members_only` agents when authorized. The publisher endpoint does not vary by tier today; the option is forwarded for symmetry and forward compatibility.
