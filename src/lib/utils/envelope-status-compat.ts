/**
 * Envelope-status back-compat shim for AdCP 3.0.x peers.
 *
 * AdCP 3.1.0-beta.2 promoted envelope `status` to a REQUIRED field on every
 * response. Sellers still on 3.0.x emit responses without `status` — that is
 * spec-correct for 3.0 but trips an 8.0-beta SDK that validates against the
 * 3.1 envelope schema.
 *
 * `injectLegacyEnvelopeStatus` synthesizes a `status` field when, and only
 * when, the response declares itself as 3.0.x (or doesn't declare a version
 * at all, which legacy emitters did). 3.1+ responses are returned unchanged
 * so the strict validator still rejects a 3.1 peer that omits `status`.
 *
 * The leniency is a back-compat affordance, not a permanent loosening.
 */

/**
 * Detect whether a response payload should be treated as 3.0.x for the
 * purposes of envelope-status leniency.
 *
 * Rules:
 *  - `adcp_version === '3'` or starts with `'3.0'` → 3.0.x
 *  - `adcp_version` starts with `'3.1'` (or any other `3.<n>` n>=1) → NOT 3.0.x
 *  - No `adcp_version` AND `adcp_major_version === 3` → 3.0.x (legacy emitter)
 *  - No version fields at all → treated as legacy (3.0.x leniency applies)
 *  - `adcp_version` declares a major other than 3 → NOT 3.0.x (no leniency)
 */
function isLegacy30xPayload(payload: Record<string, unknown>): boolean {
  const adcpVersion = payload.adcp_version;
  if (typeof adcpVersion === 'string') {
    if (
      adcpVersion === '3' ||
      adcpVersion === '3.0' ||
      adcpVersion.startsWith('3.0.') ||
      adcpVersion.startsWith('3.0-')
    ) {
      return true;
    }
    // Any other explicit version string (`3.1`, `3.1-beta`, `3.1.0-beta.3`,
    // `4.0`, `2.5`, …) declares NOT-3.0; no leniency.
    return false;
  }

  // No `adcp_version`. Legacy 3.0 emitters carry `adcp_major_version: 3`.
  const major = payload.adcp_major_version;
  if (typeof major === 'number') {
    return major === 3;
  }

  // No version fields at all — treat as a very-legacy emitter.
  return true;
}

/**
 * AdCP 3.1.0-beta.2 made envelope `status` REQUIRED. Pre-3.1 sellers may
 * omit it. When the response declares itself as 3.0.x (or doesn't declare a
 * version), inject a synthetic envelope status so strict validators don't
 * reject otherwise-conformant 3.0 responses.
 *
 * Never overwrites an existing `status`. Pure function; safe to call before
 * validation.
 *
 * @param response - The raw wire response object.
 * @returns A new object with `status` injected when the legacy-leniency
 *   rules apply; the same reference otherwise.
 */
export function injectLegacyEnvelopeStatus<T extends Record<string, unknown>>(response: T): T {
  // Defensive: only operate on plain objects.
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }

  // Don't overwrite an existing truthy `status`.
  if ('status' in response && response.status) {
    return response;
  }

  if (!isLegacy30xPayload(response)) {
    return response;
  }

  // Detect success vs failure to pick the synthetic status.
  const errors = response.errors;
  const hasErrors = Array.isArray(errors) && errors.length > 0;

  return {
    ...response,
    status: hasErrors ? 'failed' : 'completed',
  } as T;
}
