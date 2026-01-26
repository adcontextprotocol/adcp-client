/**
 * Format Renders Normalizer
 *
 * Handles conversion between v2 top-level dimensions and v3 renders array.
 * The library exposes only v3 API (renders array) to clients,
 * and internally normalizes responses from v2 servers.
 */

/**
 * Dimensions for a render
 */
export interface RenderDimensions {
  width: number;
  height: number;
}

/**
 * v3 render specification
 */
export interface FormatRender {
  /** Unique identifier for this render */
  render_id: string;
  /** Semantic role (e.g., 'primary', 'companion', 'mobile_variant') */
  role: string;
  /** Dimensions of this render */
  dimensions?: RenderDimensions;
  /** Whether dimensions come from format_id parameters */
  parameters_from_format_id?: boolean;
}

/**
 * v2 format with top-level dimensions
 */
export interface FormatV2 {
  width?: number;
  height?: number;
  dimensions?: RenderDimensions;
  [key: string]: unknown;
}

/**
 * v3 format with renders array
 */
export interface FormatV3 {
  renders?: FormatRender[];
  [key: string]: unknown;
}

/**
 * Normalize a format from v2 (top-level dimensions) to v3 (renders array).
 * If the format already has renders, returns as-is.
 */
export function normalizeFormatRenders(format: FormatV2 | FormatV3): FormatV3 {
  // Already has renders array - return as-is
  if ((format as FormatV3).renders && Array.isArray((format as FormatV3).renders)) {
    return format as FormatV3;
  }

  const v2Format = format as FormatV2;

  // Check for v2 dimensions
  const hasWidth = v2Format.width !== undefined;
  const hasHeight = v2Format.height !== undefined;
  const hasDimensions = v2Format.dimensions !== undefined;

  if (!hasWidth && !hasHeight && !hasDimensions) {
    // No dimension info - could be a template format
    // Return without renders (caller can check accepts_parameters)
    return format as FormatV3;
  }

  // Build dimensions object
  let dimensions: RenderDimensions | undefined;

  if (hasDimensions) {
    dimensions = v2Format.dimensions;
  } else if (hasWidth || hasHeight) {
    dimensions = {
      width: v2Format.width ?? 0,
      height: v2Format.height ?? 0,
    };
  }

  // Remove v2 fields and add v3 renders
  const { width, height, dimensions: _, ...rest } = v2Format;

  return {
    ...rest,
    renders: [
      {
        render_id: 'primary',
        role: 'primary',
        dimensions,
      },
    ],
  };
}

/**
 * Normalize all formats in a list_creative_formats response
 */
export function normalizeFormatsResponse(response: any): any {
  if (!response.formats || !Array.isArray(response.formats)) {
    return response;
  }

  return {
    ...response,
    formats: response.formats.map(normalizeFormatRenders),
  };
}

/**
 * Get renders from a format (normalizes v2 to v3 format)
 */
export function getFormatRenders(format: FormatV2 | FormatV3): FormatRender[] {
  const normalized = normalizeFormatRenders(format);
  return normalized.renders ?? [];
}

/**
 * Get primary render from a format
 */
export function getPrimaryRender(format: FormatV2 | FormatV3): FormatRender | undefined {
  const renders = getFormatRenders(format);
  return renders.find(r => r.role === 'primary') ?? renders[0];
}

/**
 * Get companion renders from a format
 */
export function getCompanionRenders(format: FormatV2 | FormatV3): FormatRender[] {
  const renders = getFormatRenders(format);
  return renders.filter(r => r.role === 'companion');
}

/**
 * Check if format has multiple renders (companion ads, adaptive)
 */
export function isMultiRenderFormat(format: FormatV2 | FormatV3): boolean {
  const renders = getFormatRenders(format);
  return renders.length > 1;
}

/**
 * Check if format uses v2 top-level dimensions
 */
export function usesV2Dimensions(format: any): boolean {
  return (
    (format.width !== undefined || format.height !== undefined || format.dimensions !== undefined) && !format.renders
  );
}

/**
 * Check if format uses v3 renders array
 */
export function usesV3Renders(format: any): boolean {
  return Array.isArray(format.renders);
}

/**
 * Get format dimensions (works with both v2 and v3)
 * For multi-render formats, returns primary render dimensions
 */
export function getFormatDimensions(format: FormatV2 | FormatV3): RenderDimensions | undefined {
  // v3 format - get from primary render
  if ((format as FormatV3).renders) {
    const primary = getPrimaryRender(format);
    return primary?.dimensions;
  }

  // v2 format - get from top-level
  const v2Format = format as FormatV2;
  if (v2Format.dimensions) {
    return v2Format.dimensions;
  }
  if (v2Format.width !== undefined || v2Format.height !== undefined) {
    return {
      width: v2Format.width ?? 0,
      height: v2Format.height ?? 0,
    };
  }

  return undefined;
}
