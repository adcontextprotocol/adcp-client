/**
 * Per-seller AdCP release negotiation.
 *
 * The client builds every request in the shape of its own pinned release (the
 * latest the SDK supports, unless the adopter pins lower). Before a call goes
 * out, this module picks the release actually spoken on the wire: the highest
 * release both sides support. Requests are then converted down to that
 * release and responses converted back up (see `translate.ts`).
 */

import type { AdcpCapabilities } from '../../utils/capabilities';
import { hasSchemaBundle } from '../../validation/schema-loader';

export interface ParsedAdcpRelease {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  /** Whether the source string carried a patch component (`3.1.4` vs `3.1`). */
  hasPatch: boolean;
}

export function parseAdcpRelease(value: string): ParsedAdcpRelease | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([A-Za-z0-9.-]+))?(?:\+[A-Za-z0-9.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    hasPatch: match[3] !== undefined,
    ...(match[4] !== undefined && { prerelease: match[4] }),
  };
}

/** `MAJOR.MINOR` line of a release, e.g. `'3.2'` for `'3.2.5'` or `'3.2.0-beta.6'`. */
export function adcpMinorLine(value: string): string | undefined {
  const release = parseAdcpRelease(value);
  return release ? `${release.major}.${release.minor}` : undefined;
}

/** Compare two releases by `MAJOR.MINOR` only. */
export function compareAdcpMinorLines(left: string, right: string): number {
  const a = parseAdcpRelease(left);
  const b = parseAdcpRelease(right);
  if (!a || !b) return 0;
  return a.major - b.major || a.minor - b.minor;
}

export type AdcpNegotiationSource =
  /** The seller lists the client's own minor line in `supported_versions`. */
  | 'same_release'
  /** The highest older GA line from the seller's `supported_versions`. */
  | 'supported_versions'
  /** No `supported_versions`; the release the seller served on discovery. */
  | 'served_version'
  /** A declared AdCP 3 seller with no release metadata predates 3.1. */
  | 'legacy_v3';

export interface NegotiatedAdcpRelease {
  /**
   * Release to speak on the wire. Equal to the client's own pin when the
   * seller supports the client's minor line, otherwise the seller's
   * release-precision `MAJOR.MINOR` (e.g. `'3.1'`).
   */
  version: string;
  source: AdcpNegotiationSource;
  /** Whether `version` is on an older minor line than the client pin. */
  downgraded: boolean;
}

export interface AdcpNegotiationFailure {
  version?: undefined;
  reason: 'no_common_version';
  /** The seller's advertised releases, for diagnostics. */
  advertised: string[];
}

type NegotiationCapabilities = Pick<AdcpCapabilities, 'supportedVersions' | 'servedVersion' | '_synthetic'> & {
  version?: AdcpCapabilities['version'];
  majorVersions?: AdcpCapabilities['majorVersions'];
  _raw?: Record<string, unknown>;
};

/**
 * Pick the highest AdCP release both the client and the seller support.
 *
 * - Stable clients return `undefined` when there is no authoritative evidence
 *   (missing or synthetic capabilities). Preview clients fail closed instead:
 *   only an exact supported_versions entry establishes preview support.
 * - Returns an {@link AdcpNegotiationFailure} when the seller advertises
 *   releases but none of them is on or below the client's line.
 *
 * Same-line matches return the client's exact pin so a seller that supports
 * the client's minor sees the same wire version as before negotiation
 * existed. Prereleases on older lines are never selected: a prerelease wire
 * shape matches only itself, and the SDK ships GA bundles for older lines.
 */
export function negotiateAdcpRelease(
  clientVersion: string,
  capabilities: NegotiationCapabilities | undefined
): NegotiatedAdcpRelease | AdcpNegotiationFailure | undefined {
  const client = parseAdcpRelease(clientVersion);
  if (!client) return undefined;
  if (!capabilities || capabilities._synthetic) {
    // Preview contracts are exact opt-ins. Missing or synthetic discovery
    // cannot establish that the seller implements this beta's wire shape.
    return client.prerelease ? { reason: 'no_common_version', advertised: [] } : undefined;
  }

  const advertised = (capabilities.supportedVersions ?? []).filter(v => typeof v === 'string');
  if (advertised.length > 0) {
    let best: { release: ParsedAdcpRelease; value: string } | undefined;
    for (const value of advertised) {
      const release = parseAdcpRelease(value);
      if (!release || release.major !== client.major) continue;
      if (release.minor === client.minor) {
        // Same line. A prerelease speaks only its own exact shape, on either
        // side: a beta client and a GA seller of that line do not match.
        if (release.prerelease !== client.prerelease) continue;
        if (client.prerelease && release.patch !== client.patch) continue;
        return { version: clientVersion, source: 'same_release', downgraded: false };
      }
      if (release.minor > client.minor || release.prerelease !== undefined) continue;
      // Convert only to a release the SDK ships schemas for.
      if (!hasSchemaBundle(`${release.major}.${release.minor}`)) continue;
      if (!best || release.minor > best.release.minor) best = { release, value };
    }
    if (!best) return { reason: 'no_common_version', advertised };
    return {
      version: `${best.release.major}.${best.release.minor}`,
      source: 'supported_versions',
      downgraded: true,
    };
  }

  const served =
    capabilities.servedVersion ??
    (typeof capabilities._raw?.adcp_version === 'string' ? capabilities._raw.adcp_version : undefined);
  const servedRelease = served !== undefined ? parseAdcpRelease(served) : undefined;
  if (servedRelease && servedRelease.major === client.major) {
    if (client.prerelease && (servedRelease.minor >= client.minor || servedRelease.prerelease !== undefined)) {
      // A served-version echo is not supported_versions evidence for a
      // preview. It may describe a different beta or an eventual GA shape.
      return { reason: 'no_common_version', advertised: served ? [served] : [] };
    }
    if (servedRelease.minor >= client.minor) {
      return { version: clientVersion, source: 'served_version', downgraded: false };
    }
    const servedLine = `${servedRelease.major}.${servedRelease.minor}`;
    if (servedRelease.prerelease !== undefined || !hasSchemaBundle(servedLine)) return undefined;
    return { version: servedLine, source: 'served_version', downgraded: true };
  }

  if (capabilities.version === 'v3' && client.major === 3) {
    // AdCP 3.0 predates release-precision capability metadata, so a real
    // AdCP 3 capability response with none of it is a 3.0 seller.
    if (client.minor === 0) return { version: clientVersion, source: 'legacy_v3', downgraded: false };
    return { version: '3.0', source: 'legacy_v3', downgraded: true };
  }
  return client.prerelease ? { reason: 'no_common_version', advertised: [] } : undefined;
}

export function isNegotiationFailure(
  value: NegotiatedAdcpRelease | AdcpNegotiationFailure | undefined
): value is AdcpNegotiationFailure {
  return value !== undefined && 'reason' in value;
}
