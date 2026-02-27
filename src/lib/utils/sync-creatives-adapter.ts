/**
 * Sync Creatives Adapter
 *
 * Handles conversion between v2 and v3 sync_creatives requests.
 * The library exposes only the v3 API to clients and internally adapts
 * requests for v2 servers.
 *
 * Key v3 → v2 differences:
 *   - `account` field is required in v3 but absent in v2 — stripped on send
 *   - `catalogs` array on each creative is v3-only — stripped on send
 *   - `status` enum ('approved' | 'rejected') replaces v2 `approved` boolean
 */

/**
 * Adapt a single creative asset for a v2 server.
 * Strips v3-only fields and converts `status` enum → `approved` boolean.
 */
function adaptCreativeAssetForV2(creative: any): any {
  const { catalogs, status, ...rest } = creative;

  const adapted: any = { ...rest };

  // Convert v3 status enum → v2 approved boolean
  if (status === 'approved') {
    adapted.approved = true;
  } else if (status === 'rejected') {
    adapted.approved = false;
  }
  // Any other status value (or absent) — omit approved entirely

  return adapted;
}

/**
 * Adapt a sync_creatives request for a v2 server.
 * Strips v3-only top-level fields and adapts each creative asset.
 */
export function adaptSyncCreativesRequestForV2(request: any): any {
  const { account, ...rest } = request;

  return {
    ...rest,
    ...(rest.creatives && {
      creatives: rest.creatives.map(adaptCreativeAssetForV2),
    }),
  };
}
