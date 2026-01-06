// Format Asset Utilities
// Provides backward-compatible access to format assets (v2.6 `assets` field replaces deprecated `assets_required`)

import type { Format } from '../types/tools.generated';

// Internal types - derived from Format['assets'] since schema doesn't export standalone types
type FormatAsset = NonNullable<Format['assets']>[number];
type IndividualAsset = Extract<FormatAsset, { item_type: 'individual' }>;
type RepeatableAssetGroup = Extract<FormatAsset, { item_type: 'repeatable_group' }>;

/**
 * Get assets from a Format, preferring new `assets` field, falling back to `assets_required`
 *
 * This provides backward compatibility during the migration from `assets_required` to `assets`.
 * - If `assets` exists and has items, returns it directly
 * - If only `assets_required` exists, normalizes it to the new format (sets required: true)
 * - Returns empty array if neither field exists (flexible format)
 *
 * @param format - The Format object from list_creative_formats response
 * @returns Array of assets in the new format structure
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
  // Prefer new `assets` field (v2.6+)
  if (format.assets && format.assets.length > 0) {
    return format.assets;
  }

  // Fall back to deprecated `assets_required` and normalize
  if (format.assets_required && format.assets_required.length > 0) {
    return normalizeAssetsRequired(format.assets_required);
  }

  return [];
}

/**
 * Convert deprecated assets_required to new assets format
 *
 * All assets in assets_required are required by definition (that's why they were in that array).
 * The new `assets` field has an explicit `required: boolean` to allow both required AND optional assets.
 *
 * @param assetsRequired - The deprecated assets_required array
 * @returns Normalized assets array with explicit required: true
 */
export function normalizeAssetsRequired(
  assetsRequired: NonNullable<Format['assets_required']>
): FormatAsset[] {
  return assetsRequired.map(asset => ({
    ...asset,
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
  return getFormatAssets(format).filter(
    (asset): asset is IndividualAsset => asset.item_type === 'individual'
  );
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
  return !format.assets && !!format.assets_required;
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
