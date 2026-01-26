// Format Asset Utilities
// Provides access to format assets from the v3 `assets` field

import type { Format } from '../types/tools.generated';

// Internal types - derived from Format['assets'] since schema doesn't export standalone types
type FormatAsset = NonNullable<Format['assets']>[number];
type IndividualAsset = Extract<FormatAsset, { item_type: 'individual' }>;
type RepeatableAssetGroup = Extract<FormatAsset, { item_type: 'repeatable_group' }>;

// Legacy support: v2 responses may still include assets_required (deprecated in v3)
// This internal type allows runtime backward compatibility without exposing it in public API
interface LegacyFormat extends Format {
  assets_required?: unknown[];
}

/**
 * Get assets from a Format
 *
 * Returns the assets from the v3 `assets` field. For backward compatibility with v2 servers,
 * this function also handles the deprecated `assets_required` field if present.
 *
 * @param format - The Format object from list_creative_formats response
 * @returns Array of assets
 *
 * @example
 * ```typescript
 * const formats = await agent.listCreativeFormats({});
 * for (const format of formats.formats) {
 *   const assets = getFormatAssets(format);
 *   console.log(`${format.name} has ${assets.length} assets`);
 * }
 * ```
 */
export function getFormatAssets(format: Format): FormatAsset[] {
  // Use v3 `assets` field
  if (format.assets && format.assets.length > 0) {
    return format.assets;
  }

  // Runtime backward compatibility: handle v2 responses with deprecated assets_required
  const legacyFormat = format as LegacyFormat;
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
function normalizeAssetsRequired(assetsRequired: unknown[]): FormatAsset[] {
  return assetsRequired.map(asset => ({
    ...(asset as Record<string, unknown>),
    required: true, // assets_required only contained required assets
  })) as FormatAsset[];
}

/**
 * Get only required assets from a Format
 *
 * @param format - The Format object
 * @returns Array of required assets only
 *
 * @example
 * ```typescript
 * const requiredAssets = getRequiredAssets(format);
 * console.log(`Must provide ${requiredAssets.length} assets`);
 * ```
 */
export function getRequiredAssets(format: Format): FormatAsset[] {
  return getFormatAssets(format).filter(asset => asset.required);
}

/**
 * Get only optional assets from a Format
 *
 * Note: When using deprecated `assets_required`, this will always return empty
 * since assets_required only contained required assets.
 *
 * @param format - The Format object
 * @returns Array of optional assets only
 *
 * @example
 * ```typescript
 * const optionalAssets = getOptionalAssets(format);
 * console.log(`Can optionally provide ${optionalAssets.length} additional assets`);
 * ```
 */
export function getOptionalAssets(format: Format): FormatAsset[] {
  return getFormatAssets(format).filter(asset => !asset.required);
}

/**
 * Get individual assets (not repeatable groups) from a Format
 *
 * @param format - The Format object
 * @returns Array of individual assets
 */
export function getIndividualAssets(format: Format): IndividualAsset[] {
  return getFormatAssets(format).filter((asset): asset is IndividualAsset => asset.item_type === 'individual');
}

/**
 * Get repeatable asset groups from a Format
 *
 * @param format - The Format object
 * @returns Array of repeatable asset groups
 */
export function getRepeatableGroups(format: Format): RepeatableAssetGroup[] {
  return getFormatAssets(format).filter(
    (asset): asset is RepeatableAssetGroup => asset.item_type === 'repeatable_group'
  );
}

/**
 * Check if format uses deprecated assets_required field (for migration warnings)
 *
 * @param format - The Format object
 * @returns true if using deprecated field, false if using new field or neither
 *
 * @example
 * ```typescript
 * if (usesDeprecatedAssetsField(format)) {
 *   console.warn(`Format ${format.name} uses deprecated assets_required field`);
 * }
 * ```
 */
export function usesDeprecatedAssetsField(format: Format): boolean {
  const legacyFormat = format as LegacyFormat;
  return !format.assets && !!(legacyFormat.assets_required && Array.isArray(legacyFormat.assets_required));
}

/**
 * Get the count of assets in a format (for display purposes)
 *
 * @param format - The Format object
 * @returns Number of assets, or 0 if none defined
 */
export function getAssetCount(format: Format): number {
  return getFormatAssets(format).length;
}

/**
 * Check if a format has any assets defined
 *
 * @param format - The Format object
 * @returns true if format has assets, false otherwise
 */
export function hasAssets(format: Format): boolean {
  return getAssetCount(format) > 0;
}
