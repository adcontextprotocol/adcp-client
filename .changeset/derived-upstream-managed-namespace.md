---
'@adcp/sdk': major
---

**Breaking (correction inside the unreleased v14):** `AccountStore.resolution: 'derived'` is now an upstream-managed account-id namespace, matching the account-reference model settled in [adcp#5062](https://github.com/adcontextprotocol/adcp/pull/5062). The previous wire semantics were inverted and unusable for the adapters the mode exists for — buyers who called `list_accounts` got ids that every subsequent call rejected.

Wire contract:

- `{ account_id }` is the durable reference for `'derived'` and is now **accepted** (it was refused with `INVALID_REQUEST`); the `{ brand, operator }` natural-key arm is now **refused** with `INVALID_REQUEST` (`field: 'account.brand'`) and a `list_accounts` suggestion.
- `list_accounts` is **required** for `'derived'` — `createAdcpServerFromPlatform` throws `PlatformConfigError` when neither `accounts.list` nor `opts.accounts.listAccounts` is wired. It is the discovery contract for a namespace the agent doesn't own; credential-bound singletons expose one row.
- `sync_accounts` is not categorically blocked: natural-key provisioning entries fail per-row with `UNSUPPORTED_PROVISIONING`, natural-key _references_ fail per-row with `INVALID_REQUEST`, and `account: { account_id }` settings-update entries pass through.
- A declared `'derived'` resolution projects `account.require_operator_auth: true` on `get_adcp_capabilities`, like a declared `'explicit'`.

Tenant-isolation hardening (`'derived'` only):

- `accounts.resolve` must verify buyer-supplied ids; the framework backstops it — a resolved account whose `id` isn't the one the buyer named is refused with `ACCOUNT_NOT_FOUND` (with a dev-mode warning), so an un-migrated resolver that ignores `ref` fails closed instead of cross-serving.
- `sync_accounts` and `sync_governance` entries — the two account references that never passed through `accounts.resolve` — are now resolved against the caller's reachable set before any write, on both the platform and merge-seam wirings.
- The `comply_test_controller` sandbox gate no longer accepts a wire `sandbox: true` claim alongside an `account_id` the resolver refused.

API:

- `createDerivedAccountStore` verifies buyer-supplied `account_id` against what the caller's credential can reach (fail closed → `ACCOUNT_NOT_FOUND`), auto-selects the account on ref-less tools only when exactly one is reachable, and wires a filtered, paged `list_accounts`. New `listAccounts` / `lookupAccount` options support credentials that reach many accounts; `toAccount` keeps its signature for the single-account case.
- Added `AccountResolutionMode` / `CanonicalAccountResolutionMode` types and the `normalizeAccountResolution()`, `isAccountResolutionMode()`, `refHasNaturalKey()` helpers. An unrecognized `resolution` value is now a `PlatformConfigError` rather than silently inheriting another mode's enforcement. No alias spelling is introduced — `'derived'` stays the single name.

Migration: [13 → 14 § derived account resolution](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/migration-13-to-14.md#derived-account-resolution-is-now-an-upstream-managed-account-id-namespace). Fixes #1647 and #1628.
