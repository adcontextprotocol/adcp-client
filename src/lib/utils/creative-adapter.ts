/**
 * Creative Assignment Adapter
 *
 * Handles conversion between v2 creative_ids and v3 creative_assignments.
 * The library exposes only v3 API (creative_assignments) to clients,
 * and internally adapts requests for v2 servers.
 */

/**
 * v3 creative assignment with optional weight and placement targeting
 */
export interface CreativeAssignment {
  /** Unique identifier for the creative */
  creative_id: string;
  /** Delivery weight (0-100) for rotation */
  weight?: number;
  /** Optional placement IDs to restrict where this creative runs */
  placement_ids?: string[];
}

/**
 * Package request with creative assignments (v3 style)
 */
export interface PackageRequestV3 {
  creative_assignments?: CreativeAssignment[];
  creatives?: any[]; // Full creative objects for upload
  [key: string]: unknown;
}

/**
 * Package request with creative_ids (v2 style)
 */
export interface PackageRequestV2 {
  creative_ids?: string[];
  creatives?: any[];
  [key: string]: unknown;
}

/**
 * Package response with creative assignments (v3 style)
 */
export interface PackageResponseV3 {
  creative_assignments?: CreativeAssignment[];
  [key: string]: unknown;
}

/**
 * Package response with creative_ids (v2 style)
 */
export interface PackageResponseV2 {
  creative_ids?: string[];
  [key: string]: unknown;
}

/**
 * Optional context for deriving a per-package `buyer_ref` when the v3 input
 * doesn't carry one. v2.5 `package-request.json` requires `buyer_ref` (the
 * `oneOf` accepts `package_id` OR `buyer_ref`; on creation no `package_id`
 * exists yet, so `buyer_ref` is the actual required identifier). v3 doesn't
 * model packages with `buyer_ref`, but `idempotency_key` carries equivalent
 * client-controlled-unique-identity semantics. The `parentBuyerRef` plus
 * `index` compose a stable per-package reference that re-derives identically
 * on replay — preserving the idempotency contract sellers depend on for
 * deduping.
 */
export interface PackageAdapterContext {
  /** Top-level `buyer_ref` derived from the parent v3 request. */
  parentBuyerRef?: string;
  /** Position of the package within the parent's `packages[]` array. */
  index?: number;
}

/**
 * Adapt a v3-style package request for a v2 server.
 * Converts creative_assignments to creative_ids (dropping weight and placement_ids).
 * Strips v3-only package fields (optimization_goals, catalogs).
 *
 * When `ctx` is provided and the input has no `buyer_ref`, derives one as
 * `package.idempotency_key || ${ctx.parentBuyerRef}-${ctx.index}` so v2.5
 * package-request validation passes. Caller-supplied `buyer_ref` always wins.
 */
export function adaptPackageRequestForV2(pkg: PackageRequestV3, ctx?: PackageAdapterContext): PackageRequestV2 {
  const {
    optimization_goals,
    catalogs,
    idempotency_key: pkgIdempotencyKey,
    buyer_ref: callerBuyerRef,
    ...rest
  } = pkg as PackageRequestV3 & {
    optimization_goals?: unknown;
    catalogs?: unknown;
    idempotency_key?: unknown;
    buyer_ref?: unknown;
  };

  // Derive per-package buyer_ref. Caller-supplied wins; then per-package
  // idempotency_key; then a stable composition of the parent's buyer_ref
  // and the package's array index. If none of those are available we
  // pass through without a buyer_ref and let the v2.5 validator surface
  // the missing field — better than synthesizing an unstable value that
  // breaks dedupe on replay.
  const derivedBuyerRef =
    typeof callerBuyerRef === 'string' && callerBuyerRef.length > 0
      ? callerBuyerRef
      : typeof pkgIdempotencyKey === 'string' && pkgIdempotencyKey.length > 0
        ? pkgIdempotencyKey
        : ctx?.parentBuyerRef !== undefined && ctx?.index !== undefined
          ? `${ctx.parentBuyerRef}-${ctx.index}`
          : undefined;

  const baseOut: PackageRequestV2 = rest as PackageRequestV2;
  if (!rest.creative_assignments) {
    return derivedBuyerRef === undefined ? baseOut : { ...baseOut, buyer_ref: derivedBuyerRef };
  }

  const { creative_assignments, ...withoutAssignments } = rest;

  return {
    ...withoutAssignments,
    ...(derivedBuyerRef !== undefined && { buyer_ref: derivedBuyerRef }),
    creative_ids: creative_assignments.map((a: CreativeAssignment) => a.creative_id),
  };
}

/**
 * Adapt a create_media_buy request for a v2 server.
 * Strips v3-only top-level fields, converts brand → brand_manifest, derives
 * `buyer_ref` (top-level + per-package) from `idempotency_key`, and adapts
 * packages.
 *
 * v2.5 requires `buyer_ref` as the buyer's reference for THIS media buy,
 * top-level + per-package. v3 doesn't model `buyer_ref` but `idempotency_key`
 * carries the same client-controlled-unique-identity semantics. Reusing it
 * preserves the idempotency contract sellers depend on for deduping replays:
 * the same v3 request always produces the same v2.5 `buyer_ref`. Caller-
 * supplied `buyer_ref` (if any) always wins.
 */
export function adaptCreateMediaBuyRequestForV2(request: any): any {
  const {
    account,
    proposal_id,
    total_budget,
    artifact_webhook,
    brand,
    brand_manifest: inputManifest,
    adcp_major_version,
    idempotency_key,
    buyer_ref: callerBuyerRef,
    ...rest
  } = request;

  // Proposal mode is v3-only. If packages are also present we can still satisfy the request
  // by dropping proposal_id/total_budget and using the explicit packages.
  // Only throw when there are no packages — then there's nothing to send a v2 server.
  if (proposal_id && !rest.packages?.length) {
    throw new Error(
      'Proposal mode (proposal_id + total_budget) requires a v3 server. ' +
        'The connected server only supports AdCP v2. Provide an explicit packages array instead.'
    );
  }

  // v2 brand_manifest is a URL string. Prefer the caller's original manifest
  // (which may have been re-injected after validation), falling back to
  // deriving a URL from brand.domain.
  const callerUrl =
    typeof inputManifest === 'string'
      ? inputManifest
      : typeof inputManifest === 'object' && inputManifest?.url
        ? inputManifest.url
        : undefined;
  const brand_manifest = callerUrl || (brand?.domain ? `https://${brand.domain}` : undefined);

  const buyer_ref =
    typeof callerBuyerRef === 'string' && callerBuyerRef.length > 0
      ? callerBuyerRef
      : typeof idempotency_key === 'string' && idempotency_key.length > 0
        ? idempotency_key
        : undefined;

  return {
    ...rest,
    ...(buyer_ref !== undefined && { buyer_ref }),
    ...(brand && !brand_manifest && { brand }),
    ...(brand_manifest !== undefined && { brand_manifest }),
    ...(rest.packages && {
      packages: rest.packages.map((pkg: PackageRequestV3, index: number) =>
        adaptPackageRequestForV2(pkg, { parentBuyerRef: buyer_ref, index })
      ),
    }),
  };
}

/**
 * Adapt an update_media_buy request for a v2 server.
 * Strips v3-only top-level fields and adapts packages.
 */
export function adaptUpdateMediaBuyRequestForV2(request: any): any {
  const { reporting_webhook, adcp_major_version, idempotency_key, ...rest } = request;

  return {
    ...rest,
    ...(rest.packages && { packages: rest.packages.map(adaptPackageRequestForV2) }),
  };
}

/**
 * Normalize a v2-style package response to v3.
 * Converts creative_ids to creative_assignments and coerces null array fields
 * to undefined so downstream consumers can safely use optional chaining.
 */
export function normalizePackageResponse(pkg: PackageResponseV2 | PackageResponseV3): PackageResponseV3 {
  // Coerce null array fields to undefined — some servers (e.g. Magnite) return
  // explicit nulls for optional array fields like creative_assignments,
  // creative_ids, and products. Leaving them as null causes downstream .map()
  // crashes since callers expect undefined (absent) or a real array.
  const nullArrayFields = ['creative_assignments', 'creative_ids', 'products'] as const;
  let cleaned: any = pkg;
  for (const field of nullArrayFields) {
    if (field in cleaned && cleaned[field] === null) {
      const { [field]: _removed, ...rest } = cleaned;
      cleaned = rest;
    }
  }

  // Already v3 format
  if (cleaned.creative_assignments) {
    return cleaned as PackageResponseV3;
  }

  // v2 format - convert creative_ids to creative_assignments
  if ((cleaned as PackageResponseV2).creative_ids) {
    const { creative_ids, ...rest } = cleaned as PackageResponseV2;
    return {
      ...rest,
      creative_assignments: creative_ids!.map(id => ({ creative_id: id })),
    };
  }

  // No creatives
  return cleaned as PackageResponseV3;
}

/**
 * Normalize a media buy response (converts all packages).
 */
export function normalizeMediaBuyResponse(response: any): any {
  if (!response.packages) {
    return response;
  }

  return {
    ...response,
    packages: response.packages.map(normalizePackageResponse),
  };
}

/**
 * Check if a package uses v2 creative_ids format
 */
export function usesV2CreativeIds(pkg: any): boolean {
  return Array.isArray(pkg.creative_ids) && !pkg.creative_assignments;
}

/**
 * Check if a package uses v3 creative_assignments format
 */
export function usesV3CreativeAssignments(pkg: any): boolean {
  return Array.isArray(pkg.creative_assignments);
}

/**
 * Get all creative IDs from a package (works with both v2 and v3 format)
 */
export function getCreativeIds(pkg: PackageResponseV2 | PackageResponseV3): string[] {
  if ((pkg as PackageResponseV3).creative_assignments) {
    return (pkg as PackageResponseV3).creative_assignments!.map(a => a.creative_id);
  }
  if ((pkg as PackageResponseV2).creative_ids) {
    return (pkg as PackageResponseV2).creative_ids!;
  }
  return [];
}

/**
 * Get creative assignments from a package (normalizes v2 to v3 format)
 */
export function getCreativeAssignments(pkg: PackageResponseV2 | PackageResponseV3): CreativeAssignment[] {
  if ((pkg as PackageResponseV3).creative_assignments) {
    return (pkg as PackageResponseV3).creative_assignments!;
  }
  if ((pkg as PackageResponseV2).creative_ids) {
    return (pkg as PackageResponseV2).creative_ids!.map(id => ({ creative_id: id }));
  }
  return [];
}
