/**
 * Request parameter normalization for backward compatibility.
 *
 * Converts deprecated field names and shapes so callers written against
 * earlier schema versions keep working. Each conversion emits a one-time
 * deprecation warning via warnOnce().
 */

import { brandManifestToBrandReference, promotedProductsToCatalog } from '../types/compat';
import { warnOnce } from './deprecation';

/**
 * Normalize a single package's params for backward compatibility.
 *
 * Handles:
 * - optimization_goal (scalar) → optimization_goals (array)
 * - catalog (scalar object) → catalogs (array)
 */
export function normalizePackageParams(pkg: any): any {
  if (!pkg || typeof pkg !== 'object') return pkg;

  const normalized = { ...pkg };

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
  // brand takes precedence if both are supplied.
  if (taskType === 'get_products' || taskType === 'create_media_buy') {
    if (normalized.brand_manifest && !normalized.brand) {
      const brand = brandManifestToBrandReference(normalized.brand_manifest);
      if (brand) {
        normalized.brand = brand;
      }
    }
    delete normalized.brand_manifest;
  }

  // ── Package normalization (create_media_buy, update_media_buy) ──
  if ((taskType === 'create_media_buy' || taskType === 'update_media_buy') && Array.isArray(normalized.packages)) {
    normalized.packages = normalized.packages.map(normalizePackageParams);
  }

  // ── activate_signal: deployments → destinations ──
  if (taskType === 'activate_signal') {
    if (normalized.deployments && !normalized.destinations) {
      warnOnce('deployments', 'deployments is deprecated. Use destinations instead.');
      normalized.destinations = normalized.deployments;
    }
    delete normalized.deployments;
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
        delete (normalized as any)[removed];
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
