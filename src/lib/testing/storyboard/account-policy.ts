import { resolveAccount, resolveBrand } from '../client';
import { schemaAllowsTopLevelField } from '../../validation/schema-loader';
import type { StoryboardRunOptions } from './types';

/** Discovery and negotiation must never invent an unprovisioned account. */
export const ACCOUNT_FREE_DISCOVERY_TASKS: ReadonlySet<string> = new Set([
  'get_products',
  'list_products',
  'get_signals',
  'request_proposals',
  'refine_proposals',
  'decline_proposals',
]);

/**
 * Force every outgoing request onto the storyboard's brand context.
 *
 * Sellers that scope session state by brand (spec-required for multi-tenant
 * isolation) derive a session key from `brand.domain` — or, when brand is
 * absent, from `account.brand.domain`. If any step in a run targets a
 * different brand, it lands in a different session and can't see state
 * created by earlier steps.
 *
 * This helper runs after builder / sample_request resolution and writes the
 * run-scoped brand into the addressing forms the tool's schema allows:
 *
 *   - Top-level `brand` — only when the tool's request schema declares it
 *     (e.g. `get_products`, `create_media_buy`, signal tools). Governance
 *     tools like `sync_plans` do not declare `brand` at the request root
 *     (brand belongs inside each `Plan` object) — injecting it would fail
 *     the framework's strict AJV validation (#940).
 *   - `account.brand` — merged into an existing `account` object only when
 *     it uses the natural-key variant (`{brand, operator, sandbox?}`). The
 *     `{account_id}` variant is closed (`additionalProperties: false`); merging
 *     `brand` into it produces a payload that matches neither `oneOf` branch
 *     and is rejected by AJV strict request validation. Detect the natural-key
 *     variant by looking for an existing `brand` or `operator` key.
 *   - Synthetic `account` — constructed only when the request has no
 *     `account` AND the tool's schema declares `account` (e.g. `get_media_buys`,
 *     `list_creatives`). Tools like `sync_plans` that declare neither
 *     `brand` nor `account` at the root are left unchanged.
 *
 * When `taskName` is omitted or the schema is unavailable (not synced yet),
 * the function fails open and injects as before. Schema checks use raw JSON
 * reads, not AJV internals.
 */
export function applyBrandInvariant(
  request: Record<string, unknown>,
  options: StoryboardRunOptions,
  taskName?: string,
  stepFlags?: { omit_account?: boolean }
): Record<string, unknown> {
  // Only force the invariant when the caller has actually supplied a brand.
  // Storyboards that don't exercise brand-scoped tools (e.g. security
  // probes) legitimately run without one and should pass through unchanged.
  if (!options.brand && !options.brand_manifest) return request;
  const brand = resolveBrand(options);

  // Gate brand/account injection on the tool's request schema. Tools that
  // declare `additionalProperties: false` without listing the field will fail
  // the framework's strict AJV validator if we inject it (#940). Fails open
  // when taskName is absent or the schema isn't available.
  const topBrandOk = !taskName || schemaAllowsTopLevelField(taskName, 'brand');
  const topAccountOk = !taskName || schemaAllowsTopLevelField(taskName, 'account');

  const result: Record<string, unknown> = { ...request };
  if (topBrandOk) result.brand = brand;

  // When a storyboard step sets `omit_account: true` it is deliberately
  // testing the seller's missing-account rejection path. Skip all account
  // synthesis — both the natural-key-merge branch (existing account on the
  // request) and the synthetic-construction branch (no account on the
  // request) — so the request reaches the wire exactly as authored.
  if (stepFlags?.omit_account) return result;

  if ('account' in request) {
    // Caller sent an account — merge brand in only when it's a plain object
    // using AccountReference's natural-key variant (`{brand, operator, sandbox?}`).
    // The `{account_id}` variant is a closed object; merging `brand` would
    // produce a payload that matches neither `oneOf` branch under strict AJV.
    // Leave non-object values (null, array) and `{account_id}`-only payloads
    // alone so intentionally narrow or malformed requests aren't silently
    // "corrected."
    const existingAccount = request.account;
    if (existingAccount && typeof existingAccount === 'object' && !Array.isArray(existingAccount)) {
      const acct = existingAccount as Record<string, unknown>;
      const isNaturalKeyVariant = 'brand' in acct || 'operator' in acct;
      if (isNaturalKeyVariant) {
        // Wholesale discovery storyboards deliberately address a different
        // natural-key account to prove public/account token isolation. Keep
        // that explicitly authored account identity for product and signal
        // feeds while still enforcing the run-scoped top-level brand. Other
        // tools and discovery modes retain the cross-step invariant from #579.
        const preserveWholesaleAccountBrand =
          ((taskName === 'get_products' && request.buying_mode === 'wholesale') ||
            (taskName === 'get_signals' && request.discovery_mode === 'wholesale')) &&
          acct.brand !== undefined;
        const merged: Record<string, unknown> = {
          ...acct,
          brand: preserveWholesaleAccountBrand ? acct.brand : brand,
        };
        // The natural-key arm of AccountReference requires `operator` (per
        // schemas/cache/{version}/core/account-ref.json). A fixture or earlier
        // context-extraction step that produced `{brand, sandbox}` without
        // operator would otherwise be passed through and rejected by a
        // strict-validating seller. Default operator to brand.domain — same
        // convention `resolveAccount` uses for synthetic refs.
        const accountBrand = merged.brand as { domain?: unknown } | undefined;
        if (typeof merged.operator !== 'string' && typeof accountBrand?.domain === 'string') {
          merged.operator = accountBrand.domain;
        }
        result.account = merged;
      }
    }
  } else if (topAccountOk && taskName !== 'list_accounts' && !ACCOUNT_FREE_DISCOVERY_TASKS.has(taskName ?? '')) {
    // No account on the request — construct one so tools whose schema
    // declares `account` but not top-level `brand` (e.g. get_media_buys,
    // list_creatives) still carry the run-scoped brand on the wire.
    // list_accounts is deliberately exempt: without an authored account it
    // enumerates the caller's visible accounts. Synthesizing the runner's
    // default natural key would silently narrow pagination and discovery
    // storyboards to one brand.
    result.account = resolveAccount(options);
  }
  return result;
}
