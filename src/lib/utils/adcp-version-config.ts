// Validation helpers for the per-instance `adcpVersion` constructor option
// added in Stage 2 of the multi-version refactor.
//
// Stage 2 plumbs the option onto every client/server constructor and exposes
// `getAdcpVersion()` for inspection, but the wire-level `adcp_major_version`
// field is still emitted from the global `ADCP_MAJOR_VERSION` constant.
// To prevent silent drift between the configured pin and what actually goes
// out on the wire, we fence the constructor: only `adcpVersion` strings whose
// derived major matches `ADCP_MAJOR_VERSION` are accepted today. Cross-major
// pinning (e.g. `'4.0.0-beta.1'` while the SDK ships against major 3) waits
// until Stage 3 wires the per-instance major into the protocol layer.

import { ADCP_MAJOR_VERSION, ADCP_VERSION, COMPATIBLE_ADCP_VERSIONS, parseAdcpMajorVersion } from '../version';
import { ConfigurationError } from '../errors';

/**
 * Resolve and validate a configured `adcpVersion`. Returns the value to store
 * on the instance — either the caller's pin or the SDK default.
 *
 * Throws `ConfigurationError` when the pin is unparseable or its derived major
 * differs from `ADCP_MAJOR_VERSION`. The error message points at the Stage 3+
 * roadmap so callers know cross-major support isn't a missing feature, just
 * not landed yet.
 */
export function resolveAdcpVersion(adcpVersion: string | undefined): string {
  if (adcpVersion === undefined) return ADCP_VERSION;

  const major = parseAdcpMajorVersion(adcpVersion);
  if (!Number.isFinite(major)) {
    throw new ConfigurationError(
      `adcpVersion ${JSON.stringify(adcpVersion)} is not a valid AdCP version. ` +
        `Expected a semver string (e.g. '3.0.1', '3.1.0-beta.1') or a legacy alias. ` +
        `Currently accepted: ${COMPATIBLE_ADCP_VERSIONS.filter(v => parseAdcpMajorVersion(v) === ADCP_MAJOR_VERSION).join(', ')}.`,
      'adcpVersion'
    );
  }

  if (major !== ADCP_MAJOR_VERSION) {
    throw new ConfigurationError(
      `adcpVersion ${JSON.stringify(adcpVersion)} pins major ${major}, but this ` +
        `SDK build ships against major ${ADCP_MAJOR_VERSION}. Cross-major pinning ` +
        `lands in Stage 3 of the multi-version refactor (per-instance schema + ` +
        `wire-major plumbing). Within a major, beta and patch pins are accepted: ` +
        `${COMPATIBLE_ADCP_VERSIONS.filter(v => parseAdcpMajorVersion(v) === ADCP_MAJOR_VERSION).join(', ')}.`,
      'adcpVersion'
    );
  }

  return adcpVersion;
}
