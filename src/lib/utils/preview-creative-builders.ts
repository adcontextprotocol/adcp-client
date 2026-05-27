// Typed factory helpers for `preview_creative` responses. Schema oneOf is a
// three-way switch on `response_type: "single" | "batch" | "variant"`.
// SHAPE-GOTCHAS §4.

import type {
  PreviewCreativeSingleResponse,
  PreviewCreativeBatchResponse,
  PreviewCreativeVariantResponse,
} from '../types/tools.generated';

type Tagged<T, Tag extends string> = Omit<T, 'response_type'> & { response_type: Tag };

/** Build a `single`-variant `PreviewCreativeResponse`. */
export function singlePreviewCreativeResponse(
  fields: Omit<PreviewCreativeSingleResponse, 'response_type'>
): Tagged<PreviewCreativeSingleResponse, 'single'> {
  return { ...fields, response_type: 'single' };
}

/** Build a `batch`-variant `PreviewCreativeResponse`. */
export function batchPreviewCreativeResponse(
  fields: Omit<PreviewCreativeBatchResponse, 'response_type'>
): Tagged<PreviewCreativeBatchResponse, 'batch'> {
  return { ...fields, response_type: 'batch' };
}

/** Build a `variant`-variant `PreviewCreativeResponse`. */
export function variantPreviewCreativeResponse(
  fields: Omit<PreviewCreativeVariantResponse, 'response_type'>
): Tagged<PreviewCreativeVariantResponse, 'variant'> {
  return { ...fields, response_type: 'variant' };
}

/** Grouped accessor for the three `PreviewCreativeResponse` variants. */
export const previewCreative = {
  single: singlePreviewCreativeResponse,
  batch: batchPreviewCreativeResponse,
  variant: variantPreviewCreativeResponse,
} as const;
