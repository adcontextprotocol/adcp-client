/**
 * v1 ↔ v2 Product projection layer (AdCP 3.1).
 *
 * Three public surfaces:
 *
 *   - `projectV1ProductToV2` / `projectV2ProductToV1` — the symmetric
 *     core projections. Read a Product on one side, return a Product
 *     on the other plus structured diagnostics (`source: 'sdk'`,
 *     normative spec codes + SDK-local codes).
 *
 *   - `withFormatOptions` / `augmentProductWithFormatOptions` —
 *     buyer-side response augmentation. Adds `format_options[]` to a
 *     v1-shaped get_products response so V2-aware buyers read the V2
 *     mental model regardless of the seller's wire version. Additive —
 *     `format_ids[]` is preserved.
 *
 *   - Catalog + registry primitives (`lookupV1Format`,
 *     `findCatalogEntryByCanonicalAndSize`, registry exports) for
 *     callers wiring projection into their own code paths.
 *
 * Designed to be called by adopters who want to opt into the V2 mental
 * model at 7.10 without taking the 8.0 narrowing. 8.0 will move
 * `withFormatOptions` onto the default response path; until then,
 * adopters call it explicitly.
 */

export { projectV1ProductToV2 } from './v1-to-v2';
export type { V1ToV2Result } from './v1-to-v2';

export { projectV2ProductToV1 } from './v2-to-v1';
export type { V2ToV1Result } from './v2-to-v1';

export { augmentProductWithFormatOptions, withFormatOptions, type V2AugmentedProduct } from './augment-response';

export type {
  V1FormatId,
  V2ProductFormatDeclaration,
  V2Product,
  V1Product,
  CanonicalFormatKind,
  ProjectionDiagnostic,
} from './types';

export {
  loadCatalog,
  lookupV1Format,
  findCatalogEntryByCanonicalAndSize,
  parseSizedIdTemplate,
  _resetCatalogCache,
  type V1FormatDefinition,
  type CanonicalProjectionRef,
} from './catalog';

export { isCanonicalV1Translatable } from './canonical-properties';
