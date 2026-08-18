export interface AssetValue {
  asset_type?: string;
  url?: string;
  content?: string;
  [key: string]: unknown;
}

export interface CreativeManifest {
  format_kind?: string;
  format_id?: {
    agent_url?: string;
    id?: string;
    width?: number;
    height?: number;
  };
  name?: string;
  params?: {
    width?: number;
    height?: number;
    [key: string]: unknown;
  };
  assets?: Record<string, AssetValue | AssetValue[]>;
  [key: string]: unknown;
}

export interface RenderDimensions {
  width: number;
  height: number;
}

export function renderImage(manifest: CreativeManifest, dimensions?: RenderDimensions): string;
export function renderNativeInFeed(manifest: CreativeManifest, dimensions?: RenderDimensions): string;
export function renderVast(manifest: CreativeManifest, dimensions?: RenderDimensions, label?: string): string;
