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
 * Adapt a v3-style package request for a v2 server.
 * Converts creative_assignments to creative_ids (dropping weight and placement_ids).
 */
export function adaptPackageRequestForV2(pkg: PackageRequestV3): PackageRequestV2 {
  if (!pkg.creative_assignments) {
    return pkg as PackageRequestV2;
  }

  const { creative_assignments, ...rest } = pkg;

  return {
    ...rest,
    creative_ids: creative_assignments.map(a => a.creative_id),
  };
}

/**
 * Adapt a create_media_buy request for a v2 server.
 */
export function adaptCreateMediaBuyRequestForV2(request: any): any {
  if (!request.packages) {
    return request;
  }

  return {
    ...request,
    packages: request.packages.map(adaptPackageRequestForV2),
  };
}

/**
 * Adapt an update_media_buy request for a v2 server.
 */
export function adaptUpdateMediaBuyRequestForV2(request: any): any {
  if (!request.packages) {
    return request;
  }

  return {
    ...request,
    packages: request.packages.map(adaptPackageRequestForV2),
  };
}

/**
 * Normalize a v2-style package response to v3.
 * Converts creative_ids to creative_assignments.
 */
export function normalizePackageResponse(pkg: PackageResponseV2 | PackageResponseV3): PackageResponseV3 {
  // Already v3 format
  if (pkg.creative_assignments) {
    return pkg as PackageResponseV3;
  }

  // v2 format - convert creative_ids to creative_assignments
  if ((pkg as PackageResponseV2).creative_ids) {
    const { creative_ids, ...rest } = pkg as PackageResponseV2;
    return {
      ...rest,
      creative_assignments: creative_ids!.map(id => ({ creative_id: id })),
    };
  }

  // No creatives
  return pkg as PackageResponseV3;
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
