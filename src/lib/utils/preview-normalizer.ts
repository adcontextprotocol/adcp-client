/** Helpers for reading AdCP 3 creative previews. */

export interface PreviewRendererMetadata {
  renderer_id: string;
  version: string;
  export: string;
  fidelity: 'authoritative' | 'representative';
  tracking_suppressed: boolean;
  [key: string]: unknown;
}

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
    [key: string]: unknown;
  };
  /** Renderer provenance and safety metadata; it does not independently grant authority. */
  renderer?: PreviewRendererMetadata;
  [key: string]: unknown;
}

export interface PreviewV3 {
  preview_id: string;
  renders: PreviewRenderV3[];
  input?: {
    name: string;
    macros?: Record<string, unknown>;
    context_description?: string;
    [key: string]: unknown;
  };
  interactive_url?: string;
  expires_at: string;
  [key: string]: unknown;
}

interface PreviewCreativeResponseV3 {
  previews?: PreviewV3[];
  results?: {
    success?: boolean;
    response?: { previews?: PreviewV3[]; [key: string]: unknown };
    [key: string]: unknown;
  }[];
  [key: string]: unknown;
}

/** Preserve the supplied render, including provenance and extension fields. */
export function normalizePreviewRender<T extends PreviewRenderV3>(render: T): T {
  return render;
}

/** Preserve an AdCP 3 preview and all of its supplied renders. */
export function normalizePreview<T extends PreviewV3>(preview: T): T {
  return preview;
}

/** Preserve an AdCP 3 single or batch preview response. */
export function normalizePreviewCreativeResponse<T extends PreviewCreativeResponseV3>(response: T): T {
  return response;
}

export function usesV3RenderFields(render: PreviewRenderV3): boolean {
  return render.render_id !== undefined || render.role !== undefined;
}

export function getRenderId(render: PreviewRenderV3): string {
  return render.render_id;
}

export function getRenderRole(render: PreviewRenderV3): string {
  return render.role;
}

/** Select the primary render, or the first supplied render when no primary is declared. */
export function getPrimaryPreviewRender(preview: { renders: PreviewRenderV3[] }): PreviewRenderV3 | undefined {
  return preview.renders.find(render => render.role === 'primary') ?? preview.renders[0];
}

export function getPreviewUrl(preview: { renders: PreviewRenderV3[] }): string | undefined {
  return getPrimaryPreviewRender(preview)?.preview_url;
}

export function getPreviewHtml(preview: { renders: PreviewRenderV3[] }): string | undefined {
  return getPrimaryPreviewRender(preview)?.preview_html;
}
