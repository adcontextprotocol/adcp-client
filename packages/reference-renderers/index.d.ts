export interface AssetValue {
  asset_type?: string;
  url?: string;
  content?: string;
  width?: number;
  height?: number;
  pixel_ratio?: number;
  duration_ms?: number;
  alt_text?: string;
  url_type?: string;
  media?: AssetValue;
  headline?: string;
  description?: string;
  cta?: string;
  landing_page_url?: AssetValue;
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

export interface ProductFormatDeclaration {
  format_kind: string;
  params: Record<string, unknown>;
  supported_macros?: string[];
  [key: string]: unknown;
}

export type ReferenceRendererIssueCode =
  | 'INVALID_INPUT'
  | 'INVALID_MANIFEST'
  | 'INVALID_FORMAT_DECLARATION'
  | 'FORMAT_MISMATCH'
  | 'MISSING_ASSET'
  | 'INVALID_ASSET'
  | 'CONSTRAINT_VIOLATION'
  | 'UNSUPPORTED_MACRO'
  | 'MISSING_MACRO_VALUE';

export interface ReferenceRendererIssue {
  code: ReferenceRendererIssueCode;
  path: string;
  message: string;
}

export interface ReferenceRendererInput {
  manifest: CreativeManifest;
  declaration?: ProductFormatDeclaration;
  supportedMacros?: readonly string[];
  supported_macros?: readonly string[];
  macros?: Readonly<Record<string, string>>;
}

export interface ReferenceNetworkPlan {
  eager_assets: readonly string[];
  user_navigations: readonly string[];
}

export interface PreparedMedia {
  type: 'image' | 'video';
  url: string;
  source_url: string;
  width: number;
  height: number;
  alt_text?: string;
}

export interface PreparedImagePresentation {
  format_kind: 'image';
  image: PreparedMedia & { type: 'image' };
  headline?: string;
  body_text?: string;
  primary_text?: string;
  cta?: string;
  landing_page_url?: string;
  network: ReferenceNetworkPlan;
}

export interface PreparedCarouselCard {
  media: PreparedMedia;
  headline?: string;
  description?: string;
  cta?: string;
  landing_page_url?: string;
}

export interface PreparedImageCarouselPresentation {
  format_kind: 'image_carousel';
  cards: readonly PreparedCarouselCard[];
  primary_text?: string;
  landing_page_url?: string;
  network: ReferenceNetworkPlan;
}

export type PrepareReferenceResult<T> =
  | { ok: true; presentation: T }
  | { ok: false; issues: readonly ReferenceRendererIssue[] };

export type RenderReferenceResult<T> =
  | { ok: true; presentation: T; html: string }
  | { ok: false; issues: readonly ReferenceRendererIssue[] };

export const REFERENCE_PRESENTATION_LABEL: 'Community reference presentation — non-authoritative';

export function renderImage(manifest: CreativeManifest, dimensions?: RenderDimensions): string;
export function renderNativeInFeed(manifest: CreativeManifest, dimensions?: RenderDimensions): string;
export function renderVast(manifest: CreativeManifest, dimensions?: RenderDimensions, label?: string): string;
export function prepareImageReference(input: ReferenceRendererInput): PrepareReferenceResult<PreparedImagePresentation>;
export function renderImageResult(
  input: ReferenceRendererInput,
  dimensions?: RenderDimensions
): RenderReferenceResult<PreparedImagePresentation>;
export function prepareImageCarouselReference(
  input: ReferenceRendererInput
): PrepareReferenceResult<PreparedImageCarouselPresentation>;
export function renderImageCarousel(manifest: CreativeManifest, dimensions?: RenderDimensions): string;
export function renderImageCarouselResult(
  input: ReferenceRendererInput,
  dimensions?: RenderDimensions
): RenderReferenceResult<PreparedImageCarouselPresentation>;

export interface MountedReferencePreview {
  iframe: HTMLIFrameElement;
  destroy(): void;
}

export function mountReferencePreview(
  container: HTMLElement,
  html: string,
  options?: { title?: string; loading?: 'eager' | 'lazy' }
): MountedReferencePreview;
