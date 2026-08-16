/**
 * Deprecated enum exports retained when AdCP 3.1.14 removed their source
 * schemas. Keep these through the next SDK major so a protocol patch cannot
 * break existing imports.
 */

/** @deprecated Verification badge roles moved to registry role declarations. */
export const BadgeRoleValues = [
  'media-buy',
  'creative',
  'signals',
  'governance',
  'brand',
  'sponsored-intelligence',
] as const;

/** @deprecated Verification badge roles moved to registry role declarations. */
export type BadgeRole = (typeof BadgeRoleValues)[number];

/**
 * @deprecated Use `CatalogTypeValues`; this preserves the narrower values
 * exported for the retail-media field before it adopted shared CatalogType.
 */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_SupportedCatalogTypesValues = [
  'product',
  'store',
  'offering',
  'hotel',
  'flight',
  'vehicle',
  'real_estate',
  'education',
  'destination',
  'app',
  'job',
  'inventory',
] as const;
