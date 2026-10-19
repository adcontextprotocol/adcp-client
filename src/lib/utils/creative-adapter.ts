/** Helpers for reading AdCP 3 creative assignments. */

/** Creative assignment with optional weight and placement targeting. */
export interface CreativeAssignment {
  creative_id: string;
  weight?: number;
  placement_ids?: string[];
  [key: string]: unknown;
}

export interface PackageRequestV3 {
  creative_assignments?: CreativeAssignment[];
  creatives?: unknown[];
  [key: string]: unknown;
}

export interface PackageResponseV3 {
  creative_assignments?: CreativeAssignment[];
  [key: string]: unknown;
}

/** Remove a null assignments array while preserving all extension fields. */
export function normalizePackageResponse<T extends PackageResponseV3>(pkg: T): T {
  if (pkg.creative_assignments === null) {
    const { creative_assignments: _removed, ...rest } = pkg;
    return rest as T;
  }
  return pkg;
}

/** Normalize optional arrays in the packages of an AdCP 3 media buy response. */
export function normalizeMediaBuyResponse<T extends { packages?: PackageResponseV3[] }>(response: T): T {
  if (!Array.isArray(response.packages)) {
    return response;
  }
  return {
    ...response,
    packages: response.packages.map(normalizePackageResponse),
  };
}

export function usesV3CreativeAssignments(pkg: PackageResponseV3): boolean {
  return Array.isArray(pkg.creative_assignments);
}

/** Return creative IDs in assignment order. */
export function getCreativeIds(pkg: PackageResponseV3): string[] {
  return getCreativeAssignments(pkg).map(assignment => assignment.creative_id);
}

/** Return the supplied assignments, including their weights and extension fields. */
export function getCreativeAssignments(pkg: PackageResponseV3): CreativeAssignment[] {
  return pkg.creative_assignments ?? [];
}
