---
'@adcp/sdk': minor
---

Expose `ctx.provisioning` to account resolvers, refuse supplied account references without a resolver, and enforce sellers' declared product-account requirement (#3094). Check implicit resolver identity metadata against the supplied natural key as defense in depth (#3091).

Behavior change: raw handler-bag sellers must configure a reference-aware `resolveAccount` before accepting account-carrying requests. A handler that previously authorized `params.account` itself must move that authorization into the resolver; an auth-only resolver does not authorize arbitrary account references. See the migration recipe in `docs/guides/account-resolution.md`.
