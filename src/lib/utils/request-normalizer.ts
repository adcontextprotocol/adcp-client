/**
 * Request parameter normalization for backward compatibility.
 *
 * Converts deprecated field names and shapes so callers written against
 * earlier schema versions keep working. Each conversion emits a one-time
 * deprecation warning via warnOnce().
 */

import { randomUUID } from 'crypto';

import { brandManifestToBrandReference, promotedProductsToCatalog } from '../types/compat';
import { warnOnce } from './deprecation';

/**
 * Task types whose request schema requires `idempotency_key` per AdCP spec.
 * When the caller omits one, the normalizer mints a fresh UUID — the spec
 * requires a per-(seller, request) unique value and auto-generation gives
 * that by construction for buyers that don't track their own keys.
 */
const TASKS_REQUIRING_IDEMPOTENCY_KEY: ReadonlySet<string> = new Set([
  'activate_signal',
  'calibrate_content',
  'create_media_buy',
  'delete_collection_list',
  'delete_property_list',
  'log_event',
  'provide_performance_feedback',
  'report_plan_outcome',
  'report_usage',
  'sync_accounts',
  'sync_audiences',
  'sync_catalogs',
  'sync_creatives',
  'sync_event_sources',
  'sync_governance',
  'sync_plans',
]);

/**
 * Normalize a single package's params for backward compatibility.
 *
 * Handles:
 * - context.buyer_ref → buyer_ref (pre-4.15 servers require top-level buyer_ref)
 * - optimization_goal (scalar) → optimization_goals (array)
 * - catalog (scalar object) → catalogs (array)
 */
export function normalizePackageParams(pkg: any): any {
  if (!pkg || typeof pkg !== 'object') return pkg;

  const normalized = { ...pkg };

  // context.buyer_ref → buyer_ref (backward compat for pre-4.15 AdCP servers)
  // AdCP 4.15 moved buyer_ref into context, but older servers still require it
  // at the top level. Copy it back so requests validate on both old and new servers.
  if (normalized.context?.buyer_ref && !normalized.buyer_ref) {
    normalized.buyer_ref = normalized.context.buyer_ref;
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
export function normalizeRequestParams(taskType: string, params: any): any {
  if (!params) {
    return params;
  }

  let normalized = { ...params };

  // ── idempotency_key auto-generation ──
  // Tasks that mutate state require a caller-supplied idempotency_key per
  // AdCP spec. When the caller omits it, mint a fresh UUID v4. Most buyer
  // code never needs to track keys of its own — retries via a kept-around
  // key are the less-common path, and those callers supply their own.
  if (
    TASKS_REQUIRING_IDEMPOTENCY_KEY.has(taskType) &&
    (typeof normalized.idempotency_key !== 'string' || normalized.idempotency_key.length === 0)
  ) {
    normalized.idempotency_key = randomUUID();
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

  // ── account inference (create_media_buy) ──
  // Derive account from brand when not provided so callers that pre-date
  // the required account field keep working.
  // sandbox is intentionally omitted: the normalizer cannot infer sandbox
  // intent from brand alone. Callers that need sandbox must provide account explicitly.
  if (taskType === 'create_media_buy' && !normalized.account && normalized.brand?.domain) {
    warnOnce(
      'account_from_brand',
      'create_media_buy: account is required. Inferring from brand for backward compatibility.'
    );
    normalized.account = {
      brand: normalized.brand,
      operator: normalized.brand.domain,
    };
  }

  // ── context.buyer_ref → buyer_ref (create_media_buy, update_media_buy) ──
  // AdCP 4.15 moved buyer_ref into context, but pre-4.15 servers still require
  // it at the top level. Copy it back so requests validate on both old and new servers.
  if (
    (taskType === 'create_media_buy' || taskType === 'update_media_buy') &&
    normalized.context?.buyer_ref &&
    !normalized.buyer_ref
  ) {
    normalized.buyer_ref = normalized.context.buyer_ref;
  }

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
