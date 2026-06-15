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
import { hasSchemaBundle, resolveBundleKey, toReleasePrecisionWire } from '../validation/schema-loader';

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

export function adcpVersionAliases(version: string, includeFamilyAlias = true): Set<string> {
  const aliases = new Set<string>([version]);
  const add = (value: string) => {
    aliases.add(value);
    if (includeFamilyAlias) {
      const family = prereleaseFamilyAlias(value);
      if (family) aliases.add(family);
    }
  };

  try {
    add(resolveBundleKey(version));
  } catch {
    // Keep the raw version only; the caller will report the mismatch.
  }
  try {
    add(toReleasePrecisionWire(version));
  } catch {
    // Keep the raw version only; the caller will report the mismatch.
  }
  return aliases;
}

export function isAdcpVersionSupported(version: string, supportedVersions: readonly string[]): boolean {
  if (supportedVersions.length === 0) return true;
  const aliases = adcpVersionAliases(version);
  return supportedVersions.some(v => {
    for (const supportedAlias of adcpVersionAliases(v, false)) {
      if (aliases.has(supportedAlias)) return true;
    }
    return false;
  });
}

export function isPre31AdcpVersion(version: string | undefined): boolean {
  if (version === undefined) return false;
  const trimmed = version.trim();
  if (trimmed.length === 0) return false;

  const withoutLegacyPrefix = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  const match = /^(\d+)(?:\.(\d+))?/.exec(withoutLegacyPrefix);
  if (!match?.[1]) return false;

  const major = Number.parseInt(match[1], 10);
  if (!Number.isFinite(major)) return false;
  if (major < 3) return true;
  if (major > 3) return false;

  const minor = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  return Number.isFinite(minor) && minor < 1;
}

/** Does the seller advertise AdCP 3.1+ support (via get_adcp_capabilities)? */
export function sellerAdvertises31(caps: { supportedVersions?: string[]; buildVersion?: string } | undefined): boolean {
  if (!caps) return false;
  if (caps.buildVersion && !isPre31AdcpVersion(caps.buildVersion)) return true;
  return (caps.supportedVersions ?? []).some(v => !isPre31AdcpVersion(v));
}

/**
 * Whether to omit AdCP 3.1-only request fields from the wire. Omit when the
 * client is pinned below 3.1, or when the seller does not advertise 3.1
 * support (legacy 3.0 sellers, and sellers whose capabilities were synthesized
 * from a tool list rather than declared).
 */
export function shouldOmit31Fields(
  resolvedClientVersion: string | undefined,
  caps: { supportedVersions?: string[]; buildVersion?: string } | undefined
): boolean {
  if (isPre31AdcpVersion(resolvedClientVersion)) return true;
  return !sellerAdvertises31(caps);
}

/**
 * Strip AdCP 3.1-only inline-override fields from a BrandReference, leaving the
 * identity fields (`domain`, `brand_id`) the seller resolves the brand by. The
 * BrandReference object is closed (`additionalProperties: false`) in every
 * version, so pre-3.1 sellers reject these fields; brand.json is the canonical
 * source the seller falls back to.
 */
export function omit31BrandFields<T>(brand: T): T {
  if (!brand || typeof brand !== 'object' || Array.isArray(brand)) return brand;
  const { industries, data_subject_contestation, brand_kit_override, ...rest } = brand as Record<string, unknown>;
  return rest as T;
}

function prereleaseFamilyAlias(version: string): string | undefined {
  const match = /^(\d+\.\d+-[0-9A-Za-z-]+)\.\d+$/.exec(version);
  return match?.[1];
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
