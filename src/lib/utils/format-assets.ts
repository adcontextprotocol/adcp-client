// Format Asset Utilities
// Provides access to asset-slot declarations without requiring a raw
// list_creative_formats `Format` or its legacy format identity.

import type {
  IndividualAudioAsset,
  IndividualBriefAsset,
  IndividualCatalogAsset,
  IndividualCssAsset,
  IndividualDaastAsset,
  IndividualHtmlAsset,
  IndividualImageAsset,
  IndividualJavaScriptAsset,
  IndividualMarkdownAsset,
  IndividualTextAsset,
  IndividualUrlAsset,
  IndividualVastAsset,
  IndividualVideoAsset,
  IndividualWebhookAsset,
  RepeatableGroupAsset,
} from '../types/tools.generated';

/** Canonical structural union for the slots declared in an `assets` array. */
export type CanonicalFormatAssetSlot =
  | IndividualAudioAsset
  | IndividualBriefAsset
  | IndividualCatalogAsset
  | IndividualCssAsset
  | IndividualDaastAsset
  | IndividualHtmlAsset
  | IndividualImageAsset
  | IndividualJavaScriptAsset
  | IndividualMarkdownAsset
  | IndividualTextAsset
  | IndividualUrlAsset
  | IndividualVastAsset
  | IndividualVideoAsset
  | IndividualWebhookAsset
  | RepeatableGroupAsset;

export type IndividualFormatAssetSlot = Exclude<CanonicalFormatAssetSlot, RepeatableGroupAsset>;
export type RepeatableFormatAssetGroup = RepeatableGroupAsset;

/**
 * Minimal structural input for asset inspection. It deliberately has no
 * `format_id`, `agent_url`, name, or other legacy catalog identity.
 */
export interface FormatAssetsInput {
  assets?: CanonicalFormatAssetSlot[];
  /** Deprecated v2 compatibility field; values are normalized as required slots. */
  assets_required?: unknown[];
}

// Legacy support: v2 responses may still include assets_required (deprecated in v3)
// This internal type allows runtime backward compatibility without exposing it in public API
type LegacyFormatAssetsInput = FormatAssetsInput;

/**
 * Get asset slots from any structural asset container.
 *
 * Returns the assets from the v3 `assets` field. For backward compatibility with v2 servers,
 * this function also handles the deprecated `assets_required` field if present.
 *
 * @param format - An object containing canonical `assets` slots
 * @returns Array of assets
 *
 * @example
 * ```typescript
 * const assets = getFormatAssets({
 *   assets: [FormatAsset.image({ asset_id: 'hero', required: true })]
 * });
 * ```
 */
export function getFormatAssets(format: FormatAssetsInput): CanonicalFormatAssetSlot[] {
  // Use v3 `assets` field
  if (format.assets && format.assets.length > 0) {
    return format.assets;
  }

  // Runtime backward compatibility: handle v2 responses with deprecated assets_required
  const legacyFormat = format as LegacyFormatAssetsInput;
  if (
    legacyFormat.assets_required &&
    Array.isArray(legacyFormat.assets_required) &&
    legacyFormat.assets_required.length > 0
  ) {
    return normalizeAssetsRequired(legacyFormat.assets_required);
  }

  return [];
}

/**
 * Convert deprecated assets_required to new assets format (internal use)
 *
 * All assets in assets_required are required by definition (that's why they were in that array).
 * The new `assets` field has an explicit `required: boolean` to allow both required AND optional assets.
 *
 * @param assetsRequired - The deprecated assets_required array
 * @returns Normalized assets array with explicit required: true
 * @internal
 */
function normalizeAssetsRequired(assetsRequired: unknown[]): CanonicalFormatAssetSlot[] {
  return assetsRequired.map(asset => ({
    ...(asset as Record<string, unknown>),
    required: true, // assets_required only contained required assets
  })) as CanonicalFormatAssetSlot[];
}

/**
 * Get only required slots from an asset container.
 *
 * @param format - A structural asset container
 * @returns Array of required assets only
 *
 * @example
 * ```typescript
 * const requiredAssets = getRequiredAssets(format);
 * console.log(`Must provide ${requiredAssets.length} assets`);
 * ```
 */
export function getRequiredAssets(format: FormatAssetsInput): CanonicalFormatAssetSlot[] {
  return getFormatAssets(format).filter(asset => asset.required);
}

/**
 * Get only optional slots from an asset container.
 *
 * Note: When using deprecated `assets_required`, this will always return empty
 * since assets_required only contained required assets.
 *
 * @param format - A structural asset container
 * @returns Array of optional assets only
 *
 * @example
 * ```typescript
 * const optionalAssets = getOptionalAssets(format);
 * console.log(`Can optionally provide ${optionalAssets.length} additional assets`);
 * ```
 */
export function getOptionalAssets(format: FormatAssetsInput): CanonicalFormatAssetSlot[] {
  return getFormatAssets(format).filter(asset => !asset.required);
}

/**
 * Get individual slots (not repeatable groups) from an asset container.
 *
 * @param format - A structural asset container
 * @returns Array of individual assets
 */
export function getIndividualAssets(format: FormatAssetsInput): IndividualFormatAssetSlot[] {
  return getFormatAssets(format).filter(
    (asset): asset is IndividualFormatAssetSlot => asset.item_type === 'individual'
  );
}

/**
 * Get repeatable asset groups from an asset container.
 *
 * @param format - A structural asset container
 * @returns Array of repeatable asset groups
 */
export function getRepeatableGroups(format: FormatAssetsInput): RepeatableFormatAssetGroup[] {
  return getFormatAssets(format).filter(
    (asset): asset is RepeatableFormatAssetGroup => asset.item_type === 'repeatable_group'
  );
}

/**
 * Check if format uses deprecated assets_required field (for migration warnings)
 *
 * @param format - A structural asset container
 * @returns true if using deprecated field, false if using new field or neither
 *
 * @example
 * ```typescript
 * if (usesDeprecatedAssetsField(format)) {
 *   console.warn('Asset container uses deprecated assets_required field');
 * }
 * ```
 */
export function usesDeprecatedAssetsField(format: FormatAssetsInput): boolean {
  const legacyFormat = format as LegacyFormatAssetsInput;
  return !format.assets && !!(legacyFormat.assets_required && Array.isArray(legacyFormat.assets_required));
}

/**
 * Get the count of slots in an asset container.
 *
 * @param format - A structural asset container
 * @returns Number of assets, or 0 if none defined
 */
export function getAssetCount(format: FormatAssetsInput): number {
  return getFormatAssets(format).length;
}

/**
 * Check if an asset container has any slots defined.
 *
 * @param format - A structural asset container
 * @returns true if format has assets, false otherwise
 */
export function hasAssets(format: FormatAssetsInput): boolean {
  return getAssetCount(format) > 0;
}
