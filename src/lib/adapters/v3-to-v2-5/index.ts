/**
 * Registry of v3 → v2.5 adapter pairs, one per AdCP tool.
 *
 * Add a new tool by:
 *   1. Drop a per-tool module in this directory exporting an
 *      `AdapterPair<V3Req, V25Req, V25Res, V3Res>`.
 *   2. Register it below.
 *   3. Add a fixture to `test/lib/adapter-v2-5-conformance.test.js`.
 *
 * The future v2.6 / v3.1 work follows the same shape: a sibling
 * `v3-to-v2-6/` directory with its own per-tool modules, then a dispatch
 * table keyed by `(serverVersion, toolName)`. Today's single-pair surface
 * is the smallest version of that pattern that lets v3 buyers talk to
 * v2.5 sellers without breaking.
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
 * Look up the adapter pair for a given AdCP tool when targeting a
 * v2.5 server. Returns `undefined` for tools without a registered pair —
 * caller should pass the request through unchanged.
 */
export function getV3ToV25Adapter(toolName: string): AdapterPair | undefined {
  return REGISTRY.get(toolName);
}

/**
 * Names of tools registered for v3 → v2.5 adaptation. Used by the
 * conformance test suite as the authoritative list.
 */
export function listV3ToV25AdapterTools(): string[] {
  return [...REGISTRY.keys()];
}
