import { ADCP_VERSION } from '../../version';

/**
 * Schema-cache version preference list for the v1↔v2 projection layer.
 *
 * Both `canonical-properties.ts` (for `v1_translatable` lookups) and
 * `registry.ts` (for the `v1-canonical-mapping` glob/structural entries)
 * walk the same fallback chain when locating their on-disk source. The
 * list is in preference order: the current exact pin wins; the current stable
 * bundle key follows so GA packages can find `dist/lib/schemas-data/3.1`;
 * `latest` is the last-resort candidate for environments pinned to a 3.0.x GA (which lacks
 * the 3.1 registry/canonical schemas — those loaders throw rather than
 * silently pick up a v3.0 cache).
 *
 * `ADCP_VERSION` is always first so the next 3.1 bump cannot leave the
 * projection registry/canonical lookups pinned to the previous bundle.
 */
function projectionBundleKey(version: string): string {
  const semver = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!semver) return version;
  const [, major, minor, , prerelease] = semver;
  return prerelease === undefined ? `${major}.${minor}` : version;
}

const PROJECTION_SCHEMA_CACHE_CANDIDATES = [ADCP_VERSION, projectionBundleKey(ADCP_VERSION), '3.1', 'latest'] as const;

export const SCHEMA_VERSIONS_TO_TRY: readonly string[] = Array.from(new Set(PROJECTION_SCHEMA_CACHE_CANDIDATES));
