// Validation helpers for the per-instance `adcpVersion` constructor option.
//
// Stage 2 plumbed the option onto every client/server constructor with a
// fence: cross-major pins were rejected at construction because the wire
// field and validators still keyed off the global `ADCP_MAJOR_VERSION`.
//
// Stage 3 lifts that fence. Validators now key off the resolved bundle in
// `dist/lib/schemas-data/<MAJOR.MINOR>/`, and the protocol layer derives
// the wire-level `adcp_major_version` from the per-instance pin. Construction
// now accepts any pin that has a schema bundle reachable from the SDK build,
// and rejects pins for which no bundle is present (`'4.0.0'` while the SDK
// only ships major-3 schemas, mistyped versions, etc.) with a clear pointer
// at `sync-schemas` + `build:lib`.

import { ADCP_VERSION, COMPATIBLE_ADCP_VERSIONS, parseAdcpMajorVersion } from '../version';
import { ConfigurationError } from '../errors';
import { hasSchemaBundle, resolveBundleKey } from '../validation/schema-loader';

/**
 * Resolve and validate a configured `adcpVersion`. Returns the value to store
 * on the instance — either the caller's pin or the SDK default.
 *
 * Throws `ConfigurationError` when:
 *   - The pin is unparseable as a semver / legacy alias
 *   - The pin parses but no schema bundle exists for the resolved key
 *
 * Cross-major pins are accepted as long as the corresponding bundle ships
 * with this SDK build (e.g. `'3.1.0-beta.1'` when `dist/lib/schemas-data/
 * 3.1.0-beta.1/` exists). Pins of the SDK's currently-pinned `ADCP_VERSION`
 * always succeed without an fs check — the bundle is guaranteed.
 */
export function resolveAdcpVersion(adcpVersion: string | undefined): string {
  if (adcpVersion === undefined) return ADCP_VERSION;

  const major = parseAdcpMajorVersion(adcpVersion);
  if (!Number.isFinite(major)) {
    throw new ConfigurationError(
      `adcpVersion ${JSON.stringify(adcpVersion)} is not a valid AdCP version. ` +
        `Expected a semver string (e.g. '3.0.1', '3.1.0-beta.1') or a legacy alias. ` +
        `Currently bundled: ${listBundledVersions().join(', ')}.`,
      'adcpVersion'
    );
  }

  // Skip the bundle-existence check when the pin resolves to the same bundle
  // as the SDK default — every published tarball includes that bundle by
  // construction. The bundle-key compare (rather than literal-string compare)
  // catches the common patterns: `'3.0'`, `'3.0.0'`, and `'3.0.1'` all
  // resolve to the same `'3.0'` bundle when `ADCP_VERSION === '3.0.1'`, so
  // none of those paths pay an fs round-trip.
  if (resolveBundleKey(adcpVersion) === resolveBundleKey(ADCP_VERSION)) return adcpVersion;

  if (!hasSchemaBundle(adcpVersion)) {
    const resolvedKey = resolveBundleKey(adcpVersion);
    throw new ConfigurationError(
      `adcpVersion ${JSON.stringify(adcpVersion)} resolves to bundle key "${resolvedKey}", ` +
        `but no schema bundle for that key ships with this SDK build. ` +
        `Currently bundled: ${listBundledVersions().join(', ')}. ` +
        `If you're testing against a beta that the spec repo has tagged but the SDK hasn't synced yet, ` +
        `run \`npm run sync-schemas\` and \`npm run build:lib\` to populate the cache, ` +
        `then re-construct.`,
      'adcpVersion'
    );
  }

  return adcpVersion;
}

/**
 * Filter `COMPATIBLE_ADCP_VERSIONS` to entries with a shipped bundle on this
 * SDK build. The compatibility list is the historical set of accepted version
 * strings (legacy aliases, superseded betas, current GA), but only a subset
 * has bundles in `dist/lib/schemas-data/` at any given build. Returning
 * "currently bundled: v2.5, v2.6, v3, 3.0.0-beta.3, 3.0.0, 3.0.1" would
 * mislead a caller who pinned `'v2.5'` and got "no bundle".
 *
 * Always includes `ADCP_VERSION` even when its bundle hasn't been built yet
 * (dev-tree case) so the error remains actionable on first build.
 */
function listBundledVersions(): string[] {
  const bundled = COMPATIBLE_ADCP_VERSIONS.filter(v => hasSchemaBundle(v));
  if (!bundled.includes(ADCP_VERSION as (typeof COMPATIBLE_ADCP_VERSIONS)[number])) {
    return [ADCP_VERSION, ...bundled];
  }
  return [...bundled];
}
