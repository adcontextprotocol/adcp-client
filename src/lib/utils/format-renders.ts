/** Helpers for reading AdCP 3 format renders. */

export interface RenderDimensions {
  width: number;
  height: number;
}

/** One entry in an AdCP 3 format's renders array. */
export interface FormatRenderEntry {
  render_id: string;
  role: string;
  dimensions?: RenderDimensions;
  parameters_from_format_id?: boolean;
  [key: string]: unknown;
}

/** @deprecated Use FormatRenderEntry; the package's FormatRender export is a factory namespace. */
export type FormatRender = FormatRenderEntry;

export interface FormatV3 {
  renders?: FormatRenderEntry[];
  [key: string]: unknown;
}

/** Preserve a format's supplied AdCP 3 renders and extension fields. */
export function normalizeFormatRenders<T extends FormatV3>(format: T): T {
  return format;
}

export function normalizeFormatsResponse(formats: FormatV3[]): { formats: FormatV3[] };
export function normalizeFormatsResponse<T extends { formats?: FormatV3[] }>(response: T): T;
/** Wrap a list of AdCP 3 formats, or preserve an existing response envelope. */
export function normalizeFormatsResponse<T extends { formats?: FormatV3[] }>(
  response: FormatV3[] | T
): { formats: FormatV3[] } | T {
  return Array.isArray(response) ? { formats: response } : response;
}

export function getFormatRenders(format: FormatV3): FormatRenderEntry[] {
  return format.renders ?? [];
}

/** Select the primary render, or the first supplied render when no primary is declared. */
export function getPrimaryRender(format: FormatV3): FormatRenderEntry | undefined {
  const renders = getFormatRenders(format);
  return renders.find(render => render.role === 'primary') ?? renders[0];
}

export function getCompanionRenders(format: FormatV3): FormatRenderEntry[] {
  return getFormatRenders(format).filter(render => render.role === 'companion');
}

export function isMultiRenderFormat(format: FormatV3): boolean {
  return getFormatRenders(format).length > 1;
}

export function usesV3Renders(format: FormatV3): boolean {
  return Array.isArray(format.renders);
}

/** Return the selected render's dimensions, when provided. */
export function getFormatDimensions(format: FormatV3): RenderDimensions | undefined {
  return getPrimaryRender(format)?.dimensions;
}
