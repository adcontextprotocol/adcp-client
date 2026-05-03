# Contributing to `examples/`

The `examples/` directory ships **fork-target reference adapters**: working code that adopters clone, modify, and ship. They double as integration test surface (each `hello_*` adapter is paired with a CI gate). Adopter trust in this directory is load-bearing — a copy-paste anti-pattern landed here propagates across the ecosystem.

This file documents the conventions that make the directory adopter-friendly. Apply them when adding or modifying any `hello_*_adapter_*.ts` file.

## SWAP-marker convention

Every place an adopter must replace something for production gets a `// SWAP:` marker. The convention is:

```ts
// SWAP: <one-line description of what to replace, in adopter terms>
const OPERATOR_TO_TENANT = new Map([
  /* ... */
]);
```

Adopters grep for `// SWAP:` to find seams. The density is the convention — under-marking forces adopters to read the whole file; over-marking buries the structural seams.

**Always mark:**

- Routing tables (operator → tenant, user → workspace, brand → catalog) — the lookup that ties wire input to your backend
- Upstream HTTP client construction (base URL, auth, header overrides) — the network seam
- Per-handler write sites (`tenant.X.set(...)`, `db.insert(...)`) — where row-level transactions go
- Auth-info → principal extraction (the bridge between transport credential and your user/account model)
- Hardcoded sandbox/dev defaults that production must override (sandbox booleans, dev-mode flags, in-memory stores)

**Optional but useful:**

- Error message text that adopters might localize
- Pricing/rate-card values that vary by deployment
- Test-data seeds (clearly labeled as fixture-only)

**Don't mark:**

- Schema-driven response shapes (those follow the spec, not adopter taste)
- Framework wiring (`createAdcpServerFromPlatform`, `serve()` calls) — adopters don't touch these
- Type definitions and interfaces — adopters extend, not replace

## "DO NOT DEPLOY AS-IS" banner

Hello adapters seed credentials, sandbox-only flags, and in-memory stores in plaintext. Every adapter that ships any of these gets a top-of-file banner:

```ts
/**
 * <adapter_name>
 *
 * ⚠️  DO NOT DEPLOY AS-IS. This file seeds <list-of-things> in plaintext
 *    for local exploration. Production adopters: <one-line-fix-summary>.
 *
 * <rest of header doc>
 */
```

Banner emphasis must scale to actual production risk:

- **No credentials, no in-memory state** → no banner; adopter conventions in the file body suffice
- **Hardcoded credentials OR in-memory state** → required banner with specific risks called out
- **Multi-tenant data models** → required banner mentioning tenant-isolation specifically

## File header doc

Every `hello_*` adapter starts with a JSDoc block covering:

1. **What it demonstrates** — the patterns this file teaches (e.g., "account-routed multi-tenant", "OAuth pass-through resolver", "creative-template build/preview")
2. **What it doesn't** — patterns explicitly NOT in this file that adopters might mistakenly think are here (e.g., "host-routed tenancy lives in `decisioning-platform-multi-tenant.ts`")
3. **How to run it** — `NODE_ENV=development npx tsx ...` plus any `adcp storyboard run` invocation that exercises it
4. **What to swap for production** — the FORK CHECKLIST: routing tables, credentials, in-memory stores, sandbox flags

Header verbosity earns its keep when the adapter introduces a non-obvious pattern (multi-tenancy, cross-specialism dispatch, OAuth pass-through). Don't trim header docs to look minimal — adopters cloning the file see the header before anything else.

## Naming convention

`hello_<role>_adapter_<specialism>.ts`

- `<role>` — AdCP protocol layer: `seller` (media-buy), `creative`, `signals`, `governance`, `brand`
- `<specialism>` — strips the role-implied prefix (`creative-template` → `_template`, `sales-guaranteed` → `_guaranteed`)

Examples: `hello_seller_adapter_guaranteed.ts`, `hello_creative_adapter_template.ts`, `hello_signals_adapter_marketplace.ts`

**Multi-role adapters** (e.g., the multi-tenant holdco adapter spans governance + brand-rights + property-lists) sit outside the convention. Name them after the deployment shape: `hello_seller_adapter_multi_tenant.ts`, `hello_<deployment>_adapter_<shape>.ts`. Note the exception in the README naming-convention paragraph.

## Cross-specialism dispatch

When an adapter hosts multiple specialisms (e.g., the multi-tenant holdco adapter), one specialism's handler may need to call another's. The canonical pattern is a private helper extracted from the calling specialism, not a direct sibling-method call:

```ts
class MyAdapter implements DecisioningPlatform {
  brandRights = defineBrandRightsPlatform({
    acquireRights: async (req, ctx) => {
      const denial = await this.enforceGovernance(tenant, ctx, offering, req);
      if (denial) return denial;
      // ... rest of acquire flow
    },
  });

  campaignGovernance = defineCampaignGovernancePlatform({
    checkGovernance: async (req, ctx) => {
      /* ... */
    },
  });

  private async enforceGovernance(tenant, ctx, offering, req): Promise<AcquireRightsRejected | null> {
    // Calls this.campaignGovernance.checkGovernance internally.
    // Documents the same-tenant invariant + the "do not copy into
    // single-specialism agents" warning.
  }
}
```

The helper extraction:

- Makes the data flow visible at the call site (no reading 30 lines of inline logic)
- Gives single-specialism adopters a clean copy target (they can lift just the helper they need)
- Forces an explicit place to document the in-process-call assumption (so adopters who copy into a single-specialism file see the warning)

Always include a "DO NOT copy into a single-specialism agent" warning on cross-specialism helpers.

## Tenant-isolation gates (multi-tenant adapters)

Multi-tenant adapters must fail-closed, not fail-open. The pattern:

```ts
// FAIL-CLOSED: reject when home tenant can't be resolved OR when wire
// operator maps to a different tenant than the buyer's authenticated home.
if (!homeTenantId || tenantId !== homeTenantId) {
  return {
    /* PERMISSION_DENIED */
  };
}
```

NOT this:

```ts
// FAIL-OPEN: skips the check entirely when homeTenantId is undefined.
// An adopter who forks and adds a credential without populating the
// home-tenant lookup silently disables tenant isolation.
if (homeTenantId && tenantId !== homeTenantId) {
  return {
    /* PERMISSION_DENIED */
  };
}
```

The canonical security review (`bokelley/hello-adapters-gov-rights` PR #1390 round 2) caught this exact pattern. Adopters WILL copy fail-open gates if you ship them.

## CI gate

Each `hello_*_adapter_*.ts` is paired with a three-gate CI test:

1. **Strict tsc** — file compiles against the published `dist/` types (matches what an external adopter sees)
2. **Storyboard** — boots the adapter, runs the matching specialism storyboard, asserts pass
3. **Upstream-traffic** — replays a recorded upstream-fixture trace and asserts the adapter's HTTP-out shape matches

A regression in any of these fails CI. When adding an adapter, add the three CI hooks; when modifying an adapter, run all three locally before pushing (`npm run typecheck`, `npx adcp storyboard run`, the upstream-recorder verify).

## Format check

`npm run format:check` is a hard CI gate. Run `npm run format:write` before pushing.

## Changeset

Every example change that ships as part of an adapter (file rename, new adapter, breaking change to an adapter's exported types) needs a changeset. Pure documentation changes (this file, README) don't.

## See also

- Repo-root [`CONTRIBUTING.md`](../CONTRIBUTING.md) — general dev process, IPR, commit conventions; this file scopes to `examples/` conventions only
- `examples/README.md` — the adopter-facing matrix of "if you're claiming X, fork Y"
- `skills/triage-storyboard-failure/SKILL.md` — when a storyboard fails on your fork
- `skills/build-holdco-agent/SKILL.md` — multi-tenant + multi-specialism adopter pattern (cross-references the FAIL-CLOSED gate convention from this file)
- `skills/build-seller-agent/`, `skills/build-creative-agent/`, etc. — per-specialism teaching surface adopters read alongside the example file
- CLAUDE.md (repo root) — protocol-wide conventions and the storyboard-triage rubric this skill expands
