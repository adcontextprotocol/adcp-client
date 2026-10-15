/**
 * Select the AdCP release a seller response is validated against.
 *
 * The versioning spec (`docs/reference/versioning.mdx`, "Server echoes")
 * says the seller echoes the release it actually served in `adcp_version`,
 * and buyers SHOULD validate the response against that release's schema,
 * not against their pin. When the response omits `adcp_version`, buyers
 * validate against their own pin.
 *
 * The gap matters most for `get_adcp_capabilities` under a 3.0 pin: the 3.0
 * bundle has no `adcp_version` request field, so the SDK sends only
 * `adcp_major_version: 3`, and the seller serves (and echoes) its highest 3.x
 * release. Validating that response against 3.0 reports every newer shape as
 * a schema violation.
 *
 * @internal — not part of the public API surface; may change without a major bump.
 */

import { hasSchemaBundle, toReleasePrecisionWire } from './schema-loader';

/** `core/version-envelope.json`'s `adcp_version` wire pattern (release precision). */
const RELEASE_PRECISION = /^(\d+)\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
/** Major of a numeric pin: `'3.0'`, `'3.0.25'`, `'3.1-beta'`, `'3.1.0-beta.1'`. */
const NUMERIC_PIN_MAJOR = /^(\d+)\.\d+/;

/**
 * Return the version to validate `response` against: the echoed
 * `adcp_version` when it is a usable release, otherwise `pinnedVersion`.
 *
 * The echo is used only when it is a release-precision string in the same
 * major as the pin and the SDK has a schema bundle for it. Validation stays
 * strict either way: an echo from another major, a malformed echo, or one the
 * SDK cannot validate falls back to the pin rather than skipping validation.
 * When the echo names the pinned release itself, the exact pin is returned so
 * a patch-precise pin (and any external schema root bound to it) still
 * applies. `supported_versions` is deliberately not consulted: with no echo
 * the spec says to validate against the pin.
 */
export function resolveServedValidationVersion(response: unknown, pinnedVersion: string): string {
  const pinMajor = NUMERIC_PIN_MAJOR.exec(pinnedVersion)?.[1];
  // Legacy aliases ('v2.5', 'v3') have their own adapter paths; leave them alone.
  if (pinMajor === undefined) return pinnedVersion;

  const echoed =
    response !== null && typeof response === 'object'
      ? (response as { adcp_version?: unknown }).adcp_version
      : undefined;
  if (typeof echoed !== 'string') return pinnedVersion;
  const echoMajor = RELEASE_PRECISION.exec(echoed)?.[1];
  if (echoMajor === undefined || echoMajor !== pinMajor) return pinnedVersion;

  let pinnedRelease: string;
  try {
    pinnedRelease = toReleasePrecisionWire(pinnedVersion);
  } catch {
    return pinnedVersion;
  }
  if (echoed === pinnedRelease) return pinnedVersion;
  return hasSchemaBundle(echoed) ? echoed : pinnedVersion;
}
