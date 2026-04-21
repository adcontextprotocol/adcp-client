/**
 * Catalog-item macro substitution primitives — paired observer and
 * encoder surfaces implementing the `substitution-observer-runner`
 * test-kit contract and the #2620 encoding rule.
 *
 * Two disjoint consumer classes:
 *
 *   - Runners grading conformance import from `./observer` (or the
 *     re-exports here) for `parse_html`, `fetch_and_parse`,
 *     `match_bindings`, and the assertion helpers.
 *
 *   - Sales/retail-media agents implementing the #2620 rule import
 *     `SubstitutionEncoder` from `./encoder`. It produces the exact
 *     bytes the observer expects — one shared RFC 3986 implementation
 *     means one bug-fix path for both directions.
 *
 * ```ts
 * // Seller-side
 * import { SubstitutionEncoder } from '@adcp/client/substitution';
 * const safe = new SubstitutionEncoder().encode_for_url_context(raw);
 *
 * // Runner-side
 * import { SubstitutionObserver, CATALOG_MACRO_VECTORS } from '@adcp/client/substitution';
 * const observer = new SubstitutionObserver();
 * const matches = observer.match_bindings(observer.parse_html(html), template, bindings);
 * ```
 */

export { SubstitutionObserver, PreviewFetchError } from './observer/SubstitutionObserver';
export type { ObserverFetchOptions, ObserverDispatcher } from './observer/SubstitutionObserver';

export { SubstitutionEncoder, MacroInRawValueError } from './encoder/SubstitutionEncoder';

export { CATALOG_MACRO_VECTORS, getCatalogMacroVector } from './vectors';
export type { CatalogMacroVectorName } from './vectors';

export {
  extractTrackerUrls,
  matchBindings,
  assertNoNestedExpansion,
  assertRfc3986Safe,
  assertSchemePreserved,
  assertUnreservedOnly,
  DEFAULT_MACRO_PROHIBITED_PATTERN,
  enforceSsrfPolicy,
  enforceSsrfPolicyResolved,
  DEFAULT_SSRF_POLICY,
} from './observer';

export { encodeUnreserved, equalUnderHexCasePolicy, isUnreservedOnly, divergenceOffset } from './rfc3986';

export type {
  AssertionOptions,
  AssertionResult,
  BindingMatch,
  CatalogBinding,
  CatalogMacroVector,
  PolicyResult,
  SsrfPolicy,
  TrackerUrlRecord,
} from './types';
