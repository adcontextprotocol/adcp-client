---
'@adcp/sdk': patch
---

**Fix: `AccountStore` merge-seam shadow** (`createAdcpServerFromPlatform`).

`buildAccountHandlers` previously emitted UNSUPPORTED_FEATURE stubs for `syncAccounts` / `listAccounts` whenever `platform.accounts.upsert` / `accounts.list` were undefined. Under the merge seam (platform-derived wins per-key), those stubs shadowed adopter-supplied `opts.accounts.{syncAccounts,listAccounts}` fillers — every mutating `sync_accounts` / `list_accounts` call returned UNSUPPORTED_FEATURE even though the adopter had wired a working v5-style handler.

Fixed by gating the platform-derived handler on whether `accounts.upsert` / `accounts.list` are actually defined (matching the existing `reportUsage` / `getAccountFinancials` pattern). Adopters who claim those tools without implementing the platform method AND without supplying a merge-seam override get the framework's "tool not registered" path — closer to the truth than a fabricated UNSUPPORTED_FEATURE envelope.

Two regression tests pin the behavior: `opts.accounts.syncAccounts runs when platform.accounts.upsert is undefined` and `opts.accounts.listAccounts runs when platform.accounts.list is undefined`.

Migration-doc additions:

- **`resolveIdempotencyPrincipal` MUST be forwarded.** v5.x adopters who passed it to `createAdcpServer` need to pass it to `createAdcpServerFromPlatform` too — the framework doesn't synthesize one. Without it, every mutating tool returns `SERVICE_UNAVAILABLE: Idempotency principal could not be resolved`. Symptoms look like a transient outage at first run; same call consistently fails the second time.
- **`ctx.account.authInfo` (specialism methods) vs `ctx.authInfo` (`ResolveContext` only).** Inside `accounts.resolve(ref, ctx)`, the second arg is `ResolveContext` and exposes `ctx.authInfo`. Inside a `SalesPlatform` / `AudiencePlatform` / etc. method, the second arg is `RequestContext` and the auth principal lives at `ctx.account.authInfo` — distinct shapes, same field, different paths.
- **`mergeSeam: 'strict'` from day 1.** Promoted from a tradeoff table to the recommended default for new deployments + migrations. With `strict`, the AccountStore-shadow bug above would have surfaced as `PlatformConfigError` at construction time instead of as a silent runtime UNSUPPORTED_FEATURE response — substantial DX improvement that's worth the back-compat hit during migration.
