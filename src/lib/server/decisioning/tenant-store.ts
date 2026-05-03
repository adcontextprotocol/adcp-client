/**
 * `createTenantStore` — opinionated `AccountStore` builder for multi-tenant
 * adapters. Canonicalizes the two-path resolution shape (operator-routed
 * for tools that carry `account` on the wire; auth-derived for tools that
 * don't) and bakes in the tenant-isolation gate that adopters historically
 * had to write — and silently fail to write — by hand.
 *
 * Status: Preview / 6.x.
 *
 * @public
 */

import type { ResolveContext, Account, AccountStore, SyncAccountsResultRow } from './account';
import type { AccountReference, SyncGovernanceRequest, SyncGovernanceSuccess } from '../../types/tools.generated';

type SyncGovernanceEntry = SyncGovernanceRequest['accounts'][number];
type SyncGovernanceRow = SyncGovernanceSuccess['accounts'][number];

/**
 * Adopter contract for `createTenantStore`. Every callback is sync OR async;
 * the helper awaits.
 *
 * Tenant isolation is enforced by comparing `tenantId(authTenant)` against
 * `tenantId(entryTenant)` per-entry on `sync_accounts` / `sync_governance`.
 * Mismatches produce a `'failed'` row with `code: 'PERMISSION_DENIED'` —
 * the adopter's `upsertRow` / `syncGovernanceRow` callbacks NEVER see a
 * cross-tenant entry. Fail-closed when `resolveFromAuth` returns null
 * (unknown principal): every entry fails `PERMISSION_DENIED` regardless of
 * its operator. Don't fork this around to fail-open — adopters who copied
 * the prior fail-open shape (`if (homeTenantId && tenantId !== homeTenantId)`)
 * silently disabled isolation when a credential lacked a tenant binding.
 *
 * @template TTenant Adopter's tenant model (e.g., `TenantState`, a row
 *                   from a `tenants` table). Compared via `tenantId`,
 *                   not by reference.
 * @template TCtxMeta Shape of `Account.ctx_metadata`. Threads through to
 *                    every specialism handler via `ctx.account.ctx_metadata`.
 */
export interface TenantStoreConfig<TTenant, TCtxMeta = Record<string, unknown>> {
  /**
   * Path 1: account ref carries `account_id` OR `(brand, operator)`.
   * Resolve to the tenant the ref points at — independent of who the
   * caller is. Return null if the ref is unknown (helper emits
   * `ACCOUNT_NOT_FOUND` for that row).
   *
   * Receives the full `AccountReference` so adopters can route on
   * `ref.sandbox` (Pattern 2: separate sandbox tenant) or read the
   * `account_id` arm of the discriminated union.
   */
  resolveByRef(ref: AccountReference): TTenant | null | Promise<TTenant | null>;

  /**
   * Path 2: no account ref on the wire (`get_brand_identity`, `get_rights`,
   * `provide_performance_feedback`, `list_creative_formats`). Derive the
   * tenant from the auth principal. Return null if no principal is
   * resolvable (no auth, no `agentRegistry`, principal not registered).
   *
   * Used by both `accounts.resolve(undefined, ctx)` (no-account tools)
   * AND the tenant-isolation gate on per-entry tools — `null` here
   * means EVERY entry on `sync_accounts` / `sync_governance` fails
   * `PERMISSION_DENIED` (fail-closed).
   */
  resolveFromAuth(ctx: ResolveContext): TTenant | null | Promise<TTenant | null>;

  /**
   * Stable identity for tenant-equality checks. The helper compares
   * `tenantId(authTenant) === tenantId(entryTenant)` to enforce isolation.
   * Reference equality is fragile (Postgres-backed stores hand back fresh
   * objects each fetch); a stable string id closes that gap.
   */
  tenantId(tenant: TTenant): string;

  /**
   * Project `(tenant, ref)` to the framework `Account<TCtxMeta>`. Called by
   * `accounts.resolve` after tenant resolution. Adopters thread sandbox
   * routing here (`sandbox: ref?.sandbox`), pin `ctx_metadata` for
   * downstream handlers, and shape `name` / `operator` / `brand` to match
   * the wire echo conventions their buyers expect.
   *
   * `ref` is `undefined` on Path-2 (no-account tools) — adopters returning
   * a synthetic publisher-wide singleton omit `ref?.sandbox` (no sandbox
   * boundary applies).
   */
  tenantToAccount(
    tenant: TTenant,
    ref: AccountReference | undefined,
    ctx: ResolveContext
  ): Account<TCtxMeta> | Promise<Account<TCtxMeta>>;

  /**
   * Per-entry `sync_accounts` storage callback. Called for each entry whose
   * `(authTenant === entryTenant)` check passed. Receives the resolved
   * tenant + the original ref + ctx. Returns a `SyncAccountsResultRow`.
   *
   * Cross-tenant entries and unknown-ref entries never reach this callback
   * — the helper builds `PERMISSION_DENIED` / `ACCOUNT_NOT_FOUND` rows for
   * those before invoking your code. The adopter's only job is the actual
   * upsert.
   *
   * Optional. Omit if your platform doesn't claim `sync_accounts`; the
   * helper leaves `accounts.upsert` undefined and the framework returns
   * `UNSUPPORTED_FEATURE`.
   */
  upsertRow?(
    tenant: TTenant,
    ref: AccountReference,
    ctx: ResolveContext
  ): SyncAccountsResultRow | Promise<SyncAccountsResultRow>;

  /**
   * Per-entry `sync_governance` storage callback. Same gating rules as
   * `upsertRow` — cross-tenant entries are rejected before reaching this
   * code. Adopters persist the buyer's governance-agent binding (including
   * write-only `authentication.credentials`, which the framework strips
   * from the response automatically — see `toWireSyncGovernanceRow`).
   *
   * Optional. Omit if your platform doesn't claim `sync_governance`.
   */
  syncGovernanceRow?(
    tenant: TTenant,
    entry: SyncGovernanceEntry,
    ctx: ResolveContext
  ): SyncGovernanceRow | Promise<SyncGovernanceRow>;
}

/**
 * Build an `AccountStore<TCtxMeta>` whose `resolve` / `upsert` /
 * `syncGovernance` methods enforce tenant isolation.
 *
 * The helper produces:
 *
 * - `accounts.resolve(ref, ctx)` — calls `resolveByRef(ref)` when `ref` is
 *   set, otherwise `resolveFromAuth(ctx)`. Projects via `tenantToAccount`.
 *   Returns `null` if the resolver returned `null` (framework emits
 *   `ACCOUNT_NOT_FOUND` for tools that require an account, or treats
 *   absence as "no tenant" for tools that don't).
 *
 * - `accounts.upsert(refs, ctx)` — for each ref:
 *     1. Resolve the entry's tenant via `resolveByRef`.
 *     2. Resolve the auth principal's tenant via `resolveFromAuth(ctx)`
 *        (computed once per request).
 *     3. If the entry tenant is unknown, emit `ACCOUNT_NOT_FOUND`.
 *     4. If the auth tenant is unknown OR differs from the entry tenant,
 *        emit `PERMISSION_DENIED` (fail-closed).
 *     5. Otherwise, invoke the adopter's `upsertRow`.
 *
 * - `accounts.syncGovernance(entries, ctx)` — same gating as `upsert`,
 *   shaped for the `SyncGovernanceResponseRow` arm (`status: 'failed'`
 *   with per-entry `errors`).
 *
 * `accounts.list` and `accounts.reportUsage` / `accounts.getAccountFinancials`
 * are NOT generated by this helper — those tools have shapes (cursor
 * pagination; per-row account refs spanning multiple tenants in
 * `report_usage`) that don't fit the per-entry-then-row pattern. Adopters
 * who claim those capabilities extend the returned store with
 * `Object.assign`:
 *
 * ```ts
 * const accounts = Object.assign(
 *   createTenantStore<TenantState, TenantMeta>({...}),
 *   { list: async (filter, ctx) => { ... } }
 * );
 * ```
 *
 * **Direct mutation of `upsert` / `syncGovernance` is locked.** The helper
 * makes those properties non-writable (`Object.defineProperty`) so an
 * adopter who writes `accounts.upsert = customHandler` after construction
 * gets a TypeError instead of silently bypassing the tenant gate. If you
 * really need a different `upsert`, don't use the helper — write a plain
 * `AccountStore` and own the gate.
 */
export function createTenantStore<TTenant, TCtxMeta = Record<string, unknown>>(
  config: TenantStoreConfig<TTenant, TCtxMeta>
): AccountStore<TCtxMeta> {
  const store: AccountStore<TCtxMeta> = {
    resolve: async (ref, ctx) => {
      const resolveCtx = ctx ?? {};
      const tenant = ref ? await config.resolveByRef(ref) : await config.resolveFromAuth(resolveCtx);
      if (tenant == null) return null;
      return await config.tenantToAccount(tenant, ref, resolveCtx);
    },
  };

  if (config.upsertRow) {
    const upsertRow = config.upsertRow;
    const upsert: NonNullable<AccountStore<TCtxMeta>['upsert']> = async (refs, ctx) => {
      const resolveCtx = ctx ?? {};
      const authTenant = await config.resolveFromAuth(resolveCtx);
      const authTenantKey = authTenant != null ? config.tenantId(authTenant) : undefined;
      // Sequential, not Promise.all: adopter `upsertRow` callbacks
      // commonly mutate shared tenant state (the multi-tenant adapter's
      // `tenant.accounts.set(...)` is the canonical example). Concurrent
      // invocations against the same tenant are an entropy source the
      // helper shouldn't introduce. Adopters who want parallel writes
      // can fan out inside their callback against an upstream that
      // tolerates it.
      const rows: SyncAccountsResultRow[] = [];
      for (const ref of refs) {
        const entryTenant = await config.resolveByRef(ref);
        if (entryTenant == null) {
          rows.push(buildSyncAccountsFailedRow(ref, 'ACCOUNT_NOT_FOUND', accountNotFoundMessage(ref)));
          continue;
        }
        const entryKey = config.tenantId(entryTenant);
        if (authTenantKey == null || authTenantKey !== entryKey) {
          rows.push(buildSyncAccountsFailedRow(ref, 'PERMISSION_DENIED', permissionDeniedMessage(ref)));
          continue;
        }
        rows.push(await upsertRow(entryTenant, ref, resolveCtx));
      }
      return rows;
    };
    Object.defineProperty(store, 'upsert', { value: upsert, writable: false, configurable: false, enumerable: true });
  }

  if (config.syncGovernanceRow) {
    const syncGovernanceRow = config.syncGovernanceRow;
    const syncGovernance: NonNullable<AccountStore<TCtxMeta>['syncGovernance']> = async (entries, ctx) => {
      const resolveCtx = ctx ?? {};
      const authTenant = await config.resolveFromAuth(resolveCtx);
      const authTenantKey = authTenant != null ? config.tenantId(authTenant) : undefined;
      const rows: SyncGovernanceRow[] = [];
      for (const entry of entries) {
        const entryTenant = await config.resolveByRef(entry.account);
        if (entryTenant == null) {
          rows.push(buildSyncGovernanceFailedRow(entry, 'ACCOUNT_NOT_FOUND', accountNotFoundMessage(entry.account)));
          continue;
        }
        const entryKey = config.tenantId(entryTenant);
        if (authTenantKey == null || authTenantKey !== entryKey) {
          rows.push(buildSyncGovernanceFailedRow(entry, 'PERMISSION_DENIED', permissionDeniedMessage(entry.account)));
          continue;
        }
        rows.push(await syncGovernanceRow(entryTenant, entry, resolveCtx));
      }
      return rows;
    };
    Object.defineProperty(store, 'syncGovernance', {
      value: syncGovernance,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }

  return store;
}

/**
 * `AccountReference` is a discriminated union (`{account_id} | {brand, operator}`).
 * The helper's failure-row builders read fields across both arms — schema
 * validation upstream guarantees one arm is populated, so widening to
 * "all-optional" here is safe and avoids per-arm casts at four call sites.
 */
function narrowAccountRef(ref: AccountReference): {
  account_id?: string;
  operator?: string;
  brand?: { domain?: string };
} {
  return ref as { account_id?: string; operator?: string; brand?: { domain?: string } };
}

/**
 * Build a failed `sync_accounts` row when the helper rejects an entry
 * (cross-tenant or unknown ref). The wire schema requires `brand` +
 * `operator` on every row, so when the input ref is `account_id`-only
 * we synthesize `'unknown'` placeholders — the buyer's `errors[0].code`
 * is the actionable signal; `brand` / `operator` here are wire-required
 * scaffolding, not authoritative echoes.
 */
function buildSyncAccountsFailedRow(
  ref: AccountReference,
  code: 'ACCOUNT_NOT_FOUND' | 'PERMISSION_DENIED',
  message: string
): SyncAccountsResultRow {
  const r = narrowAccountRef(ref);
  return {
    brand: { domain: r.brand?.domain ?? 'unknown.example' },
    operator: r.operator ?? 'unknown',
    action: 'failed',
    status: 'rejected',
    errors: [{ code, message }],
    ...(r.account_id != null && { account_id: r.account_id }),
  };
}

function buildSyncGovernanceFailedRow(
  entry: SyncGovernanceEntry,
  code: 'ACCOUNT_NOT_FOUND' | 'PERMISSION_DENIED',
  message: string
): SyncGovernanceRow {
  return {
    account: entry.account,
    status: 'failed',
    errors: [{ code, message }],
  };
}

function accountNotFoundMessage(ref: AccountReference): string {
  const r = narrowAccountRef(ref);
  if (r.account_id) return `Unknown account_id: ${r.account_id}`;
  if (r.operator) return `Unknown operator: ${r.operator}`;
  return 'Unknown account reference';
}

function permissionDeniedMessage(ref: AccountReference): string {
  const r = narrowAccountRef(ref);
  const subject = r.operator ?? r.account_id ?? 'this account';
  return `Buyer agent has no authority over '${subject}' (tenant mismatch or auth principal not registered).`;
}
