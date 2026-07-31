---
'@adcp/sdk': major
---

**Breaking:** `createTenantStore`'s `refAccess` is now required, with no default.

It previously defaulted to `'ref-routed'`, under which `accounts.resolve` returns whatever tenant the buyer's ref names without consulting the authenticated principal. That is correct for an agency hub whose single credential legitimately spans tenants — and a cross-tenant **spend** hole for a hub whose tenants are unrelated clients, since `resolve` is the account path for `create_media_buy` and `update_media_buy`. Nothing in the code can distinguish those two deployments, so a default silently picked one.

Both values remain available and neither behavior changed; only the choice is now explicit.

- `'auth-scoped'` — a ref resolving to a tenant other than `resolveFromAuth(ctx)` returns `null` (framework emits `ACCOUNT_NOT_FOUND`). Correct for most multi-tenant deployments.
- `'ref-routed'` — previous default. Keep it only if one credential is _supposed_ to span tenants, and layer a `resolve-presets` guard (`requireAccountMatch` / `requireAdvertiserMatch` / `requireOrgScope`) via `composeMethod`.

Migration is one line per `createTenantStore` call. TypeScript reports it at the call site; the helper also throws at construction on a missing or unrecognized value, so JS adopters and `as any` casts can't fall through to the permissive branch silently.

Note that `refAccess` governs `resolve` **only** — `upsert` / `syncGovernance` enforce the per-entry tenant gate either way. An adopter who had verified the sync-tool gate was never covered on `resolve`, which is what made the old default easy to miss.

`skills/build-holdco-agent/SKILL.md` — the doc an adopter actually follows — never mentioned `refAccess` while its front-matter promised "per-tenant data isolation". It now documents the choice, adds a "What the helper does NOT guarantee" section, and `skills/cross-cutting.md` no longer describes the helper as an unqualified isolation gate.
