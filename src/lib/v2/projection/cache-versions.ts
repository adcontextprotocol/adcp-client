/**
 * Schema-cache version preference list for the v1↔v2 projection layer.
 *
 * Both `canonical-properties.ts` (for `v1_translatable` lookups) and
 * `registry.ts` (for the `v1-canonical-mapping` glob/structural entries)
 * walk the same fallback chain when locating their on-disk source. The
 * list is in preference order: the current beta wins; older betas
 * survive for adopters who haven't synced; `latest` is the last-resort
 * candidate for environments pinned to a 3.0.x GA (which lacks the 3.1
 * registry/canonical schemas — those loaders throw rather than silently
 * pick up a v3.0 cache).
 *
 * Single source of truth so the next beta bump touches one file, not two.
 */
export const BETA_VERSIONS_TO_TRY: readonly string[] = [
  '3.1.0-beta.7',
  '3.1.0-beta.5',
  '3.1.0-beta.3',
  '3.1.0-beta.2',
  '3.1.0-beta.1',
  '3.1.0-beta.0',
  'latest',
];
