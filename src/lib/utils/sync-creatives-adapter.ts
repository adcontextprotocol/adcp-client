/**
 * Sync Creatives Adapter
 *
 * Adapts v3 `sync_creatives` request payloads for v2.5 servers. The public
 * surface (`adaptSyncCreativesRequestForV2`) is unchanged; all conversions
 * are transparent to callers.
 *
 * v3 → v2 field mappings applied here:
 *   - `account` / `adcp_major_version` — stripped (v3-only top-level fields)
 *   - `catalogs` per creative — stripped (v3-only)
 *   - `status` enum ('approved' | 'rejected') → `approved` boolean
 *   - `assets` — role-keyed manifest passed through, but the inner
 *     `asset_type` discriminator is stripped from each role's value. v3
 *     uses `asset_type` as the asset-shape discriminator (the const
 *     embedded in the asset). v2.5 uses the role KEY as the discriminator
 *     (the manifest property name); each variant in v2.5's `oneOf` does
 *     not declare `asset_type`. Leaving it in produces ambiguous oneOf
 *     matches against v2.5 sellers that strict-validate on extras.
 *   - No `assets` field — omitted.
 *
 * @internal Not part of the public @adcp/sdk API surface.
 */

/**
 * Strip the v3 `asset_type` discriminator from each role's asset value.
 * v2.5 uses the role key as the discriminator — `asset_type` is a v3-only
 * field that confuses v2.5 oneOf validation. Pass through anything that
 * isn't a plain object (defensive — fixtures and tests sometimes use
 * synthesized non-object values).
 */
function stripAssetTypeFromManifest(assets: unknown): unknown {
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) return assets;
  const out: Record<string, unknown> = {};
  for (const [role, value] of Object.entries(assets as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const { asset_type: _ignored, ...rest } = value as Record<string, unknown>;
      out[role] = rest;
    } else {
      out[role] = value;
    }
  }
  return out;
}

/**
 * Adapt a single creative for a v2 server.
 * Strips v3-only fields, converts `status` enum → `approved` boolean,
 * and strips the v3 `asset_type` discriminator from each role's asset
 * (v2.5 discriminates by role key, not by an embedded `asset_type`).
 */
function adaptCreativeForV2(creative: any): any {
  const { catalogs, status, assets, ...rest } = creative;

  const base: any = { ...rest };

  // Convert v3 status enum → v2 approved boolean
  if (status === 'approved') {
    base.approved = true;
  } else if (status === 'rejected') {
    base.approved = false;
  }
  // Any other status value (or absent) — omit approved entirely

  if (assets === undefined) {
    return base;
  }

  return { ...base, assets: stripAssetTypeFromManifest(assets) };
}

/**
 * Adapt a sync_creatives request for a v2 server.
 * Strips v3-only top-level fields and adapts each creative.
 */
export function adaptSyncCreativesRequestForV2(request: any): any {
  const { account, adcp_major_version, ...rest } = request;

  return {
    ...rest,
    ...(rest.creatives && {
      creatives: rest.creatives.map(adaptCreativeForV2),
    }),
  };
}
