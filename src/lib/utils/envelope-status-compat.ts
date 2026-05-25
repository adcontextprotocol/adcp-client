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
 * at all, which legacy emitters did). For media-buy create/update responses,
 * it also translates the pre-3.1 top-level lifecycle `status` into
 * `media_buy_status` so it doesn't collide with the 3.1 task-envelope status
 * enum during validation. The same translation applies to the documented 3.1
 * deprecation window for top-level `status: MediaBuyStatus`. Other 3.1+
 * responses are returned unchanged so the strict validator still rejects a
 * peer that omits or misuses `status`.
 *
 * The leniency is a back-compat affordance, not a permanent loosening.
 */

import { getAuthoritativeMediaBuyStatus } from './media-buy-status';

export interface LegacyEnvelopeStatusOptions {
  /**
   * AdCP task name for task-specific legacy body-status normalization.
   * `create_media_buy` and `update_media_buy` historically used top-level
   * `status` for MediaBuyStatus; AdCP 3.1 also uses top-level `status` for
   * the protocol task envelope.
   */
  toolName?: string;
}

const MEDIA_BUY_STATUS_RESPONSE_TOOLS = new Set(['create_media_buy', 'update_media_buy']);

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
 * Never overwrites an existing task-status. Legacy media-buy lifecycle
 * statuses are moved to `media_buy_status` and replaced with the envelope
 * status `completed`. Pure function; safe to call before validation.
 *
 * @param response - The raw wire response object.
 * @returns A new object with `status` injected when the legacy-leniency
 *   rules apply; the same reference otherwise.
 */
export function injectLegacyEnvelopeStatus<T extends Record<string, unknown>>(
  response: T,
  options?: LegacyEnvelopeStatusOptions
): T {
  // Defensive: only operate on plain objects.
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }

  if (
    options?.toolName &&
    MEDIA_BUY_STATUS_RESPONSE_TOOLS.has(options.toolName) &&
    allowsDeprecatedMediaBuyStatus(response) &&
    isMediaBuySuccessStatusForCompat(response)
  ) {
    const mediaBuyStatus = response.status;
    return {
      ...response,
      status: 'completed',
      media_buy_status: response.media_buy_status ?? mediaBuyStatus,
    } as T;
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

export function normalizeLegacyMediaBuyStatusForReturn<T extends Record<string, unknown>>(
  response: T,
  options?: LegacyEnvelopeStatusOptions
): T {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }
  if (
    !options?.toolName ||
    !MEDIA_BUY_STATUS_RESPONSE_TOOLS.has(options.toolName) ||
    !allowsDeprecatedMediaBuyStatus(response) ||
    !isMediaBuySuccessStatusForCompat(response)
  ) {
    return response;
  }
  const status = getAuthoritativeMediaBuyStatus(response);
  if (!status || response.media_buy_status === status) return response;
  return { ...response, media_buy_status: status } as T;
}

function isMediaBuySuccessStatusForCompat(response: Record<string, unknown>): boolean {
  const status = response.status;
  if (getAuthoritativeMediaBuyStatus(response) !== status) return false;
  if (typeof response.media_buy_status === 'string' && response.media_buy_status !== status) {
    return false;
  }
  // Submitted/working/input-required are task statuses, not media-buy states.
  // The media-buy artifact check keeps terminal task statuses like canceled or
  // rejected from being translated on error/task envelopes.
  return typeof response.media_buy_id === 'string';
}

function allowsDeprecatedMediaBuyStatus(payload: Record<string, unknown>): boolean {
  const adcpVersion = payload.adcp_version;
  if (typeof adcpVersion === 'string') {
    return (
      adcpVersion === '3' ||
      adcpVersion === '3.0' ||
      adcpVersion.startsWith('3.0.') ||
      adcpVersion.startsWith('3.0-') ||
      adcpVersion === '3.1' ||
      adcpVersion.startsWith('3.1.') ||
      adcpVersion.startsWith('3.1-')
    );
  }
  const major = payload.adcp_major_version;
  if (typeof major === 'number') return major === 3;
  return true;
}
