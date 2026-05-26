import type { FormatReferenceStructuredObject } from '../../types/core.generated';
import type {
  AgentPlacementFormatDeclaration,
  CustomFormatDeclaration,
  DAASTAudioFormatDeclaration,
  DisplayTagFormatDeclaration,
  HTML5FormatDeclaration,
  HostedAudioFormatDeclaration,
  HostedVideoFormatDeclaration,
  ImageAsset,
  ImageCarouselFormatDeclaration,
  ImageFormatDeclaration,
  NativeInFeedFormatDeclaration,
  ProductFormatDeclaration,
  ResponsiveCreativeFormatDeclaration,
  SponsoredPlacementFormatDeclaration,
  VASTVideoFormatDeclaration,
} from '../../types/tools.generated';

type WithCommonDeclaration<T> = ProductFormatDeclaration & T;

interface CanonicalFormatDeclarationMap {
  image: WithCommonDeclaration<ImageFormatDeclaration>;
  html5: WithCommonDeclaration<HTML5FormatDeclaration>;
  display_tag: WithCommonDeclaration<DisplayTagFormatDeclaration>;
  image_carousel: WithCommonDeclaration<ImageCarouselFormatDeclaration>;
  video_hosted: WithCommonDeclaration<HostedVideoFormatDeclaration>;
  video_vast: WithCommonDeclaration<VASTVideoFormatDeclaration>;
  audio_hosted: WithCommonDeclaration<HostedAudioFormatDeclaration>;
  audio_daast: WithCommonDeclaration<DAASTAudioFormatDeclaration>;
  sponsored_placement: WithCommonDeclaration<SponsoredPlacementFormatDeclaration>;
  native_in_feed: WithCommonDeclaration<NativeInFeedFormatDeclaration>;
  responsive_creative: WithCommonDeclaration<ResponsiveCreativeFormatDeclaration>;
  agent_placement: WithCommonDeclaration<AgentPlacementFormatDeclaration>;
  custom: WithCommonDeclaration<CustomFormatDeclaration>;
}

export type CanonicalFormatKind = keyof CanonicalFormatDeclarationMap;
export type CanonicalFormatDeclaration<K extends CanonicalFormatKind = CanonicalFormatKind> =
  CanonicalFormatDeclarationMap[K];
export type CanonicalFormatParams<K extends CanonicalFormatKind> = CanonicalFormatDeclaration<K>['params'];
export type CanonicalFormatDeclarationFields<K extends CanonicalFormatKind = CanonicalFormatKind> = Omit<
  CanonicalFormatDeclaration<K>,
  'format_kind' | 'params'
>;

export type FormatReferenceInput = FormatReferenceStructuredObject & Record<string, unknown>;

export interface ProductCardFields {
  image?: ImageAsset;
  title?: string;
  description?: string;
  price_label?: string;
  cta_label?: string;
}

export interface ProductCardDetailedFields {
  hero_image?: ImageAsset;
  carousel_images?: ImageAsset[];
  title?: string;
  description?: string;
  specifications?: Array<{ label: string; value: string }>;
  price_label?: string;
  cta_label?: string;
}

/**
 * Build the structured v1 format_id reference shape. Use this instead of a
 * bare string when populating Product.format_ids, ProductFormatDeclaration
 * v1_format_ref, or list_creative_formats filters.
 */
export function formatRef(
  agent_url: string,
  id: string,
  fields: Omit<Partial<FormatReferenceStructuredObject>, 'agent_url' | 'id'> & Record<string, unknown> = {}
): FormatReferenceStructuredObject {
  return { ...fields, agent_url, id };
}

export function formatRefs(...refs: FormatReferenceInput[]): FormatReferenceStructuredObject[] {
  return refs.map(ref => ({ ...ref }));
}

/**
 * Generic canonical-format declaration builder. It sets the format_kind
 * discriminator and keeps common declaration metadata in the third argument.
 */
export function canonicalFormatDeclaration<K extends CanonicalFormatKind>(
  format_kind: K,
  params: CanonicalFormatParams<K>,
  fields: CanonicalFormatDeclarationFields<K> = {} as CanonicalFormatDeclarationFields<K>
): CanonicalFormatDeclaration<K> {
  return { ...fields, format_kind, params } as CanonicalFormatDeclaration<K>;
}

export function imageFormatDeclaration(
  params: CanonicalFormatParams<'image'>,
  fields: CanonicalFormatDeclarationFields<'image'> = {}
): CanonicalFormatDeclaration<'image'> {
  return canonicalFormatDeclaration('image', params, fields);
}

export function html5FormatDeclaration(
  params: CanonicalFormatParams<'html5'>,
  fields: CanonicalFormatDeclarationFields<'html5'> = {}
): CanonicalFormatDeclaration<'html5'> {
  return canonicalFormatDeclaration('html5', params, fields);
}

export function displayTagFormatDeclaration(
  params: CanonicalFormatParams<'display_tag'>,
  fields: CanonicalFormatDeclarationFields<'display_tag'> = {}
): CanonicalFormatDeclaration<'display_tag'> {
  return canonicalFormatDeclaration('display_tag', params, fields);
}

export function imageCarouselFormatDeclaration(
  params: CanonicalFormatParams<'image_carousel'>,
  fields: CanonicalFormatDeclarationFields<'image_carousel'> = {}
): CanonicalFormatDeclaration<'image_carousel'> {
  return canonicalFormatDeclaration('image_carousel', params, fields);
}

export function videoHostedFormatDeclaration(
  params: CanonicalFormatParams<'video_hosted'>,
  fields: CanonicalFormatDeclarationFields<'video_hosted'> = {}
): CanonicalFormatDeclaration<'video_hosted'> {
  return canonicalFormatDeclaration('video_hosted', params, fields);
}

export function videoVastFormatDeclaration(
  params: CanonicalFormatParams<'video_vast'>,
  fields: CanonicalFormatDeclarationFields<'video_vast'> = {}
): CanonicalFormatDeclaration<'video_vast'> {
  return canonicalFormatDeclaration('video_vast', params, fields);
}

export function audioHostedFormatDeclaration(
  params: CanonicalFormatParams<'audio_hosted'>,
  fields: CanonicalFormatDeclarationFields<'audio_hosted'> = {}
): CanonicalFormatDeclaration<'audio_hosted'> {
  return canonicalFormatDeclaration('audio_hosted', params, fields);
}

export function audioDaastFormatDeclaration(
  params: CanonicalFormatParams<'audio_daast'>,
  fields: CanonicalFormatDeclarationFields<'audio_daast'> = {}
): CanonicalFormatDeclaration<'audio_daast'> {
  return canonicalFormatDeclaration('audio_daast', params, fields);
}

export function sponsoredPlacementFormatDeclaration(
  params: CanonicalFormatParams<'sponsored_placement'>,
  fields: CanonicalFormatDeclarationFields<'sponsored_placement'> = {}
): CanonicalFormatDeclaration<'sponsored_placement'> {
  return canonicalFormatDeclaration('sponsored_placement', params, fields);
}

export function nativeInFeedFormatDeclaration(
  params: CanonicalFormatParams<'native_in_feed'>,
  fields: CanonicalFormatDeclarationFields<'native_in_feed'> = {}
): CanonicalFormatDeclaration<'native_in_feed'> {
  return canonicalFormatDeclaration('native_in_feed', params, fields);
}

export function responsiveCreativeFormatDeclaration(
  params: CanonicalFormatParams<'responsive_creative'>,
  fields: CanonicalFormatDeclarationFields<'responsive_creative'> = {}
): CanonicalFormatDeclaration<'responsive_creative'> {
  return canonicalFormatDeclaration('responsive_creative', params, fields);
}

export function agentPlacementFormatDeclaration(
  params: CanonicalFormatParams<'agent_placement'>,
  fields: CanonicalFormatDeclarationFields<'agent_placement'> = {}
): CanonicalFormatDeclaration<'agent_placement'> {
  return canonicalFormatDeclaration('agent_placement', params, fields);
}

export function customFormatDeclaration(
  format_shape: string,
  format_schema: NonNullable<CanonicalFormatDeclarationFields<'custom'>['format_schema']>,
  params: CanonicalFormatParams<'custom'>,
  fields: Omit<CanonicalFormatDeclarationFields<'custom'>, 'format_shape' | 'format_schema'> = {}
): CanonicalFormatDeclaration<'custom'> {
  return canonicalFormatDeclaration('custom', params, { ...fields, format_shape, format_schema });
}

/**
 * Product cards describe the merchandising UI for a product. They do not carry
 * format_id and are intentionally separate from creative format declarations.
 */
export function productCard(fields: ProductCardFields): ProductCardFields {
  return { ...fields };
}

export function productCardDetailed(fields: ProductCardDetailedFields): ProductCardDetailedFields {
  return {
    ...fields,
    carousel_images: fields.carousel_images?.map(image => ({ ...image })),
    specifications: fields.specifications?.map(spec => ({ ...spec })),
  };
}

export const CanonicalFormat = {
  ref: formatRef,
  refs: formatRefs,
  declaration: canonicalFormatDeclaration,
  image: imageFormatDeclaration,
  html5: html5FormatDeclaration,
  displayTag: displayTagFormatDeclaration,
  imageCarousel: imageCarouselFormatDeclaration,
  videoHosted: videoHostedFormatDeclaration,
  videoVast: videoVastFormatDeclaration,
  audioHosted: audioHostedFormatDeclaration,
  audioDaast: audioDaastFormatDeclaration,
  sponsoredPlacement: sponsoredPlacementFormatDeclaration,
  nativeInFeed: nativeInFeedFormatDeclaration,
  responsiveCreative: responsiveCreativeFormatDeclaration,
  agentPlacement: agentPlacementFormatDeclaration,
  custom: customFormatDeclaration,
  productCard,
  productCardDetailed,
} as const;
