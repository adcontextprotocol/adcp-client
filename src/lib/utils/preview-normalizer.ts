/**
 * Preview Response Normalizer
 *
 * Handles conversion between v2 output_id/output_role and v3 render_id/role.
 * The library exposes only v3 API to clients.
 */

/**
 * v3 preview render
 */
export interface PreviewRenderV3 {
  render_id: string;
  role: string;
  output_format: 'url' | 'html' | 'both';
  preview_url?: string;
  preview_html?: string;
  dimensions?: {
    width: number;
    height: number;
  };
  embedding?: {
    recommended_sandbox?: string;
    requires_https?: boolean;
    supports_fullscreen?: boolean;
    csp_policy?: string;
  };
}

/**
 * v2 preview render (with old field names)
 */
export interface PreviewRenderV2 {
  output_id?: string;
  output_role?: string;
  render_id?: string;
  role?: string;
  output_format: 'url' | 'html' | 'both';
  preview_url?: string;
  preview_html?: string;
  dimensions?: {
    width: number;
    height: number;
  };
  embedding?: {
    recommended_sandbox?: string;
    requires_https?: boolean;
    supports_fullscreen?: boolean;
    csp_policy?: string;
  };
}

/**
 * v3 preview object
 */
export interface PreviewV3 {
  preview_id: string;
  renders: PreviewRenderV3[];
  input?: {
    name: string;
    macros?: Record<string, unknown>;
    context_description?: string;
  };
  interactive_url?: string;
  expires_at: string;
}

/**
 * Normalize a preview render from v2 to v3 format
 */
export function normalizePreviewRender(render: PreviewRenderV2): PreviewRenderV3 {
  return {
    // Prefer v3 field names, fall back to v2
    render_id: render.render_id ?? render.output_id ?? 'primary',
    role: render.role ?? render.output_role ?? 'primary',
    output_format: render.output_format,
    preview_url: render.preview_url,
    preview_html: render.preview_html,
    dimensions: render.dimensions,
    embedding: render.embedding,
  };
}

/**
 * Normalize a preview object (normalizes all renders)
 */
export function normalizePreview(preview: any): PreviewV3 {
  if (!preview.renders || !Array.isArray(preview.renders)) {
    return preview;
  }

  return {
    ...preview,
    renders: preview.renders.map(normalizePreviewRender),
  };
}

/**
 * Normalize a preview_creative response (single or batch)
 */
export function normalizePreviewCreativeResponse(response: any): any {
  // Single response with previews array
  if (response.previews && Array.isArray(response.previews)) {
    return {
      ...response,
      previews: response.previews.map(normalizePreview),
    };
  }

  // Batch response with results array
  if (response.results && Array.isArray(response.results)) {
    return {
      ...response,
      results: response.results.map((result: any) => {
        if (result.success && result.response?.previews) {
          return {
            ...result,
            response: {
              ...result.response,
              previews: result.response.previews.map(normalizePreview),
            },
          };
        }
        return result;
      }),
    };
  }

  return response;
}

/**
 * Check if a render uses v2 field names
 */
export function usesV2RenderFields(render: any): boolean {
  return (
    (render.output_id !== undefined || render.output_role !== undefined) &&
    render.render_id === undefined &&
    render.role === undefined
  );
}

/**
 * Check if a render uses v3 field names
 */
export function usesV3RenderFields(render: any): boolean {
  return render.render_id !== undefined || render.role !== undefined;
}

/**
 * Get render ID from a render (works with both v2 and v3)
 */
export function getRenderId(render: PreviewRenderV2 | PreviewRenderV3): string {
  return (
    (render as PreviewRenderV3).render_id ??
    (render as PreviewRenderV2).output_id ??
    'primary'
  );
}

/**
 * Get render role from a render (works with both v2 and v3)
 */
export function getRenderRole(render: PreviewRenderV2 | PreviewRenderV3): string {
  return (
    (render as PreviewRenderV3).role ??
    (render as PreviewRenderV2).output_role ??
    'primary'
  );
}

/**
 * Get primary render from a preview
 */
export function getPrimaryPreviewRender(
  preview: { renders: (PreviewRenderV2 | PreviewRenderV3)[] }
): PreviewRenderV3 | undefined {
  const renders = preview.renders.map(normalizePreviewRender);
  return renders.find((r) => r.role === 'primary') ?? renders[0];
}

/**
 * Get preview URL from primary render
 */
export function getPreviewUrl(
  preview: { renders: (PreviewRenderV2 | PreviewRenderV3)[] }
): string | undefined {
  return getPrimaryPreviewRender(preview)?.preview_url;
}

/**
 * Get preview HTML from primary render
 */
export function getPreviewHtml(
  preview: { renders: (PreviewRenderV2 | PreviewRenderV3)[] }
): string | undefined {
  return getPrimaryPreviewRender(preview)?.preview_html;
}
