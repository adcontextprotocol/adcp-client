/**
 * Request parameter normalization for backward compatibility.
 *
 * Converts deprecated field names and shapes so callers written against
 * earlier schema versions keep working. Each conversion emits a one-time
 * deprecation warning via warnOnce().
 */

import { ValidationError } from '../errors';
import { brandManifestToBrandReference, promotedProductsToCatalog } from '../types/compat';
import { warnOnce } from './deprecation';
import { MUTATING_TASKS, generateIdempotencyKey } from './idempotency';

/**
 * Normalize a single package's params for backward compatibility.
 *
 * Handles:
 * - optimization_goal (scalar) → optimization_goals (array)
 * - catalog (scalar object) → catalogs (array)
 *
 * Does NOT copy `context.buyer_ref` up to a top-level `buyer_ref`. The top-level
 * field was removed from the package schema in AdCP 3.0 and strict v3 receivers
 * reject it. When a request routes to a v2.5 seller, the v2 adapter in
 * `creative-adapter.ts` derives `buyer_ref` (from a caller-supplied value,
 * `context.buyer_ref`, `idempotency_key`, or parent/index) — that adapter is
 * gated on `serverVersion !== 'v3'`, so the field only lands on the wire for
 * sellers that still expect it.
 */
export function normalizePackageParams(pkg: any): any {
  if (!pkg || typeof pkg !== 'object') return pkg;

  const normalized = { ...pkg };

  // Fail-closed on pre-3.0 shapes that cannot be translated without data loss.
  // product_ids[] → product_id: which id wins? No safe answer.
  // budget: {total, currency} → budget: number: which currency? No safe answer.
  // v2 sunset: unsupported as of 3.0 GA (April 2026).
  //
  // Intentional asymmetry vs get_products.product_ids (lines below), which uses
  // warnOnce+delete because that field is a query filter that can simply be dropped.
  // PackageRequest.product_id and .budget are required identifiers — dropping them
  // produces a different invalid request; throwing early is strictly better.
  //
  // This error is thrown at the client boundary before any network call and must not
  // be forwarded on the wire. It uses ValidationError (VALIDATION_ERROR) as the
  // nearest semantic fit in the client error hierarchy.
  if (Array.isArray(normalized.product_ids) && normalized.product_ids.length > 0) {
    throw new ValidationError(
      'packages[].product_ids',
      normalized.product_ids,
      'pre-3.0 shape not supported in AdCP 3.0. Use product_id (singular string) instead.'
    );
  }
  if (normalized.budget !== null && typeof normalized.budget === 'object') {
    throw new ValidationError(
      'packages[].budget',
      normalized.budget,
      'pre-3.0 shape not supported in AdCP 3.0. Use budget as a number instead.'
    );
  }

  // optimization_goal (scalar) → optimization_goals (array)
  if (normalized.optimization_goal && !normalized.optimization_goals?.length) {
    warnOnce(
      'optimization_goal',
      'PackageRequest.optimization_goal is deprecated. Use optimization_goals (array) instead.'
    );
    normalized.optimization_goals = [normalized.optimization_goal];
  }
  delete normalized.optimization_goal;

  // catalog (scalar) → catalogs (array)
  if (normalized.catalog && !normalized.catalogs?.length) {
    warnOnce('catalog', 'PackageRequest.catalog is deprecated. Use catalogs (array) instead.');
    normalized.catalogs = [normalized.catalog];
  }
  delete normalized.catalog;

  return normalized;
}

/**
 * Normalize request params for backward compatibility.
 *
 * Infers missing fields that can be derived from deprecated params so callers
 * written against older schema versions keep working.
 */
export function normalizeRequestParams(
  taskType: string,
  params: any,
  opts: { skipIdempotencyAutoInject?: boolean; skipAccountValidation?: boolean } = {}
): any {
  if (!params) {
    return params;
  }

  const normalized = { ...params };

  // ── idempotency_key auto-generation ──
  // Tasks that mutate state require a caller-supplied idempotency_key per
  // AdCP spec. When the caller omits one, mint a fresh UUID v4. Most buyer
  // code never needs to track keys of its own — retries via a kept-around
  // key are the less-common path, and those callers supply their own.
  // `opts.skipIdempotencyAutoInject` disables this for compliance testing.
  // MUTATING_TASKS is derived from the Zod request schemas at module load
  // so this stays in sync with the upstream spec — no hand-maintained list.
  if (
    !opts.skipIdempotencyAutoInject &&
    MUTATING_TASKS.has(taskType) &&
    (typeof normalized.idempotency_key !== 'string' || normalized.idempotency_key.length === 0)
  ) {
    normalized.idempotency_key = generateIdempotencyKey();
  }

  // ── Universal shims (all tools) ──
  // Always delete deprecated fields, even when the new field already exists,
  // to prevent Zod strict validation failures on unknown keys.

  // account_id (bare string) → account: { account_id }
  if (typeof normalized.account_id === 'string' && !normalized.account) {
    warnOnce('account_id', 'account_id is deprecated. Use account: { account_id } instead.');
    normalized.account = { account_id: normalized.account_id };
  }
  delete normalized.account_id;

  // campaign_ref → buyer_campaign_ref
  if (normalized.campaign_ref && !normalized.buyer_campaign_ref) {
    warnOnce('campaign_ref', 'campaign_ref is deprecated. Use buyer_campaign_ref instead.');
    normalized.buyer_campaign_ref = normalized.campaign_ref;
  }
  delete normalized.campaign_ref;

  // ── brand_manifest → brand (get_products, create_media_buy) ──
  // update_media_buy has no brand field in either v2 or v3 — excluded deliberately.
  // Derive brand from brand_manifest when only the manifest is supplied.
  // brand takes precedence if both are supplied.
  // brand_manifest is preserved — agents may still require it.
  if (taskType === 'get_products' || taskType === 'create_media_buy') {
    if (normalized.brand_manifest && !normalized.brand) {
      const brand = brandManifestToBrandReference(normalized.brand_manifest);
      if (brand) {
        normalized.brand = brand;
      }
    }
  }

  // ── account validation (create_media_buy) ──
  // account is required per AdCP 3.0 spec. The v2 shim that inferred
  // operator = brand.domain was removed with the v2 sunset (April 2026):
  // the fabricated operator value was semantically wrong for any caller
  // with a buying-side intermediary, and it caused the compliance harness
  // to issue badges against requests with fabricated account data.
  // Callers must pass account as { account_id } or { brand, operator, sandbox? }.
  // Use list_accounts to discover an existing account_id, or sync_accounts
  // to register a new natural-key account.
  if (taskType === 'create_media_buy' && !normalized.account && !opts.skipAccountValidation) {
    throw new ValidationError(
      'account',
      undefined,
      'create_media_buy: account is required. ' +
        'Pass account as { account_id } or { brand, operator, sandbox? }. ' +
        'Use list_accounts to discover an existing account_id; ' +
        'implicit-account sellers also support sync_accounts to register a new one.'
    );
  }

  // Top-level `buyer_ref` on create_media_buy / update_media_buy was removed
  // from the AdCP request schema in 3.0. It is NOT derived from `context.buyer_ref`
  // here — strict v3 receivers reject it as an unknown field. The v2.5 adapter in
  // `creative-adapter.ts` performs the derivation for legacy servers only, gated
  // on `serverVersion !== 'v3'`.

  // ── Package normalization (create_media_buy, update_media_buy) ──
  if ((taskType === 'create_media_buy' || taskType === 'update_media_buy') && Array.isArray(normalized.packages)) {
    normalized.packages = normalized.packages.map(normalizePackageParams);
  }

  // ── activate_signal: field normalization ──
  if (taskType === 'activate_signal') {
    if (normalized.deployments && !normalized.destinations) {
      warnOnce('deployments', 'deployments is deprecated. Use destinations instead.');
      normalized.destinations = normalized.deployments;
    }
    delete normalized.deployments;

    if (normalized.signal_id && !normalized.signal_agent_segment_id) {
      warnOnce('signal_id', 'signal_id is deprecated. Use signal_agent_segment_id instead.');
      normalized.signal_agent_segment_id = normalized.signal_id;
    }
    delete normalized.signal_id;

    if (normalized.destination && !normalized.destinations) {
      warnOnce('destination', 'destination (singular) is deprecated. Use destinations (array) instead.');
      normalized.destinations = [normalized.destination];
    }
    delete normalized.destination;

    if (normalized.options) {
      warnOnce('activate_signal.options', 'activate_signal: options is not part of the AdCP spec and will be removed.');
    }
    delete normalized.options;
  }

  // ── get_signals: deliver_to → destinations ──
  if (taskType === 'get_signals') {
    if (normalized.deliver_to && !normalized.destinations) {
      warnOnce('deliver_to', 'deliver_to is deprecated. Use destinations and countries instead.');
      normalized.destinations = normalized.deliver_to;
    }
    delete normalized.deliver_to;
  }

  // ── get_products-specific normalization ──
  if (taskType === 'get_products') {
    // Infer buying_mode from brief presence if not supplied
    if (!normalized.buying_mode) {
      normalized.buying_mode = normalized.brief ? 'brief' : 'wholesale';
    }

    // Strip removed v2 fields that would fail strict validation
    for (const removed of ['feedback', 'product_ids', 'proposal_id'] as const) {
      if (removed in normalized) {
        warnOnce(`get_products.${removed}`, `GetProductsRequest.${removed} has been removed in v3.`);
        delete (normalized as Record<string, unknown>)[removed];
      }
    }

    // Convert legacy product_selectors (v3 beta / v2 era) → catalog so strict validation passes.
    // catalog takes precedence if both are supplied.
    if (normalized.product_selectors && !normalized.catalog) {
      normalized.catalog = promotedProductsToCatalog(normalized.product_selectors);
    }
    delete normalized.product_selectors;
  }

  return normalized;
}
