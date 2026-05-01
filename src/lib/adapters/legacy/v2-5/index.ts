/**
 * Registry of legacy v2.5 adapter pairs, one per AdCP tool.
 *
 * The SDK's current pin (v3 today) is implicit — this module describes
 * what the buyer sends to and receives from a v2.5 seller, regardless of
 * which v3.x patch the SDK itself speaks. When the SDK pin moves to v4,
 * this directory continues to hold the v2.5 compat shim and a sibling
 * `legacy/v3/` would join for v3 sellers.
 *
 * Add a new tool by:
 *   1. Drop a per-tool module in this directory exporting an
 *      `AdapterPair<V3Req, V25Req, V25Res, V3Res>`.
 *   2. Register it below.
 *   3. Add a fixture to `test/lib/adapter-v2-5-conformance.test.js`.
 *
 * Naming intentionally matches `legacy/<seller-version>/`, NOT
 * `<sdk-version>-to-<seller-version>/`. Real ad-tech compat layers carry
 * N=1 active legacy shim with a deprecation runway (OpenRTB, Prebid, GAM
 * all behave this way) — the directory tree should reflect "exceptional,
 * time-boxed" rather than encoding a matrix nobody will staff.
 */

import type { AdapterPair } from './types';
import { getProductsAdapter } from './get_products';
import { createMediaBuyAdapter } from './create_media_buy';
import { updateMediaBuyAdapter } from './update_media_buy';
import { syncCreativesAdapter } from './sync_creatives';
import { listCreativeFormatsAdapter } from './list_creative_formats';
import { previewCreativeAdapter } from './preview_creative';

export type { AdapterPair } from './types';

const PAIRS: ReadonlyArray<AdapterPair> = [
  getProductsAdapter,
  createMediaBuyAdapter,
  updateMediaBuyAdapter,
  syncCreativesAdapter,
  listCreativeFormatsAdapter,
  previewCreativeAdapter,
];

const REGISTRY: ReadonlyMap<string, AdapterPair> = new Map(PAIRS.map(p => [p.toolName, p]));

/**
 * Look up the legacy adapter pair for a given AdCP tool when targeting
 * a v2.5 seller. Returns `undefined` for tools without a registered pair
 * — caller should pass the request through unchanged.
 */
export function getV25Adapter(toolName: string): AdapterPair | undefined {
  return REGISTRY.get(toolName);
}

/**
 * Names of tools registered for v2.5 adaptation. Used by the conformance
 * test suite as the authoritative list.
 */
export function listV25AdapterTools(): string[] {
  return [...REGISTRY.keys()];
}
