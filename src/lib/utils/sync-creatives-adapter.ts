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
 *   - `assignments` array → creative-keyed package arrays. v3 models one
 *     creative/package edge per array entry; v2.5 groups those edges under
 *     the creative ID.
 *   - `weight` / `placement_ids` assignments — rejected because v2.5 has no
 *     wire representation for either constraint. Silently dropping them
 *     would broaden or change delivery.
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

type V3CreativeAssignment = {
  creative_id: string;
  package_id: string;
  weight?: number;
  placement_ids?: string[];
};

/**
 * Project v3's edge-list assignments into v2.5's creative-keyed mapping.
 *
 * The v2.5 shape cannot express weights or placement restrictions. Refuse
 * those requests rather than silently changing their trafficking semantics.
 */
function adaptAssignmentsForV2(assignments: V3CreativeAssignment[]): Record<string, string[]> {
  const packagesByCreative = new Map<string, string[]>();

  for (const [index, assignment] of assignments.entries()) {
    const unsupportedFields = [
      assignment.weight !== undefined ? 'weight' : undefined,
      assignment.placement_ids !== undefined ? 'placement_ids' : undefined,
    ].filter((field): field is string => field !== undefined);

    if (unsupportedFields.length > 0) {
      throw new Error(
        `sync_creatives assignment at index ${index} for creative ${JSON.stringify(assignment.creative_id)} uses ` +
          `${unsupportedFields.join(' and ')}, which AdCP v2.5 cannot represent. ` +
          'Remove those constraints or use a v3 seller.'
      );
    }

    const packageIds = packagesByCreative.get(assignment.creative_id) ?? [];
    packageIds.push(assignment.package_id);
    packagesByCreative.set(assignment.creative_id, packageIds);
  }

  return Object.fromEntries(packagesByCreative);
}

/**
 * Adapt a sync_creatives request for a v2 server.
 * Strips v3-only top-level fields and adapts each creative.
 */
export function adaptSyncCreativesRequestForV2(request: any): any {
  const { account, adcp_major_version, assignments, ...rest } = request;

  return {
    ...rest,
    ...(assignments !== undefined && {
      assignments: adaptAssignmentsForV2(assignments),
    }),
    ...(rest.creatives && {
      creatives: rest.creatives.map(adaptCreativeForV2),
    }),
  };
}
