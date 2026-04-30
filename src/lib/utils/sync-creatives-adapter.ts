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
 *   - `assets` as a role-keyed manifest ({ video: { asset_type, url, … } })
 *     → flattened to a single v2 asset payload (`oneOf` discriminated by
 *     `asset_type`). The primary (first) role is forwarded; remaining roles
 *     are dropped with a console.warn naming the discarded roles. To preserve
 *     all roles, connect to a v3 server.
 *   - `assets` already flat (has `asset_type` at top level) — passed through
 *     unchanged.
 *   - No `assets` field — omitted.
 *
 * @internal Not part of the public @adcp/sdk API surface.
 */

/**
 * Returns true for a v3 role-keyed manifest ({ role: AssetInstance, … }).
 * Returns false for a flat v2 asset payload (has top-level `asset_type`),
 * for an empty object, or for any non-plain-object value.
 */
function isManifestShape(assets: unknown): boolean {
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) return false;
  if ('asset_type' in assets) return false; // already a flat single-asset payload
  const values = Object.values(assets as object);
  // Empty object is not a manifest — treat as pass-through
  return values.some(v => typeof v === 'object' && v !== null && 'asset_type' in v);
}

/**
 * Adapt a single creative for a v2 server.
 * Strips v3-only fields, converts `status` enum → `approved` boolean,
 * and flattens a manifest-shaped `assets` to a single v2 asset payload.
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
    // v3 schema marks assets as required, but guard defensively for any
    // typed as any that arrives without the field
    return base;
  }

  if (!isManifestShape(assets)) {
    // Already a flat asset payload (has asset_type at top level), an empty
    // object, or an unrecognised shape — pass through verbatim and let the
    // server's response validation surface any mismatch
    return { ...base, assets };
  }

  // Manifest: { role: AssetInstance, … }
  // isManifestShape guarantees at least one entry with asset_type, so entries is non-empty
  const entries = Object.entries(assets as Record<string, unknown>);
  const [primaryRole, primaryAsset] = entries[0]!;

  if (entries.length > 1) {
    const allRoles = entries.map(([r]) => r);
    console.warn(
      `[AdCP] sync_creatives: creative "${base.creative_id}" has multiple asset roles ` +
        `(${allRoles.join(', ')}); only "${primaryRole}" will be sent to v2 server. ` +
        `Upgrade to a v3 server to preserve all roles.`
    );
  }

  return { ...base, assets: primaryAsset };
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
