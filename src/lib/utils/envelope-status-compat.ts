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
 * peer that omits or misuses `status`. A bare `completed` / `rejected` /
 * `canceled` is never treated as a lifecycle when the payload, or failing
 * that the caller's requested release (`options.adcpVersion`), is 3.1+:
 * there it is the task envelope status.
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
  /**
   * AdCP release the caller requested or negotiated for this exchange (for
   * example the client's `adcpVersion` pin, or the release negotiated down
   * from it). The response `adcp_version` echo is optional, so a seller on
   * 3.1+ may answer a create with only `{ status: 'completed', media_buy_id }`.
   * `completed`, `rejected` and `canceled` are valid both as TaskStatus and as
   * MediaBuyStatus. When the payload carries no version echo, this release
   * decides which one a bare top-level `status` is: on 3.1+ it is the task
   * envelope status and is never copied into `media_buy_status`. An explicit
   * `adcp_version` / `adcp_major_version` on the payload always wins. When
   * neither the payload nor the caller knows the release, the legacy 3.0
   * reading still applies.
   */
  adcpVersion?: string;
}

const MEDIA_BUY_STATUS_RESPONSE_TOOLS = new Set(['create_media_buy', 'update_media_buy']);

/**
 * Compact synchronous responses that the 3.0 shim must never give a `status`.
 *
 * 3.0 emitters never served these tools. On 3.2.x the schema forbids `status`;
 * from the release that composes `core/protocol-envelope.json` into every task
 * response it is REQUIRED, and a missing one is the seller's defect, not
 * something to fill in. `list_collections` and `list_proposals` are 3.3-only.
 */
export const COMPACT_SYNC_RESPONSE_TOOLS: ReadonlySet<string> = new Set([
  'list_products',
  'decline_proposals',
  'list_collections',
  'list_proposals',
]);

/** Tools whose 3.2.x arms are closed with no `status`; 3.3 composes the envelope into them. */
const STATUS_FREE_BEFORE_ENVELOPE_TOOLS: ReadonlySet<string> = new Set(['list_products', 'decline_proposals']);

/**
 * True when the served release's published schema for `toolName` has no
 * `status`, so a seller serving that release must not emit it: 3.2.x
 * `list_products` / `decline_proposals`. False for every other tool, and for a
 * release whose schema composes the protocol envelope (3.3 and the 3.2.x
 * backport), where `status` is required and preserved.
 *
 * The release's own schema decides, not a version number, so a bundle that
 * adds the envelope later changes the answer without a code change. An unknown
 * version or a release with no such schema keeps `status`.
 */
export function omitsEnvelopeStatusForRelease(toolName: string, servedVersion: string | undefined): boolean {
  if (!STATUS_FREE_BEFORE_ENVELOPE_TOOLS.has(toolName) || servedVersion === undefined) return false;
  const key = `${toolName}\0${servedVersion}`;
  const cached = omitsStatusCache.get(key);
  if (cached !== undefined) return cached;
  const loader = envelopeSchemaLoader();
  const composes = loader.responseSchemaComposesEnvelope(toolName, servedVersion);
  const omits = composes === false;
  // Bundles are immutable for a process except when a test or runner registers an
  // external root, which changes what the same version string resolves to. An
  // unresolved version is not cached either: a root registered for it later
  // must be consulted.
  if (omitsStatusCache.size < 256 && composes !== undefined && !loader.isExternalSchemaRootActive(servedVersion))
    omitsStatusCache.set(key, omits);
  return omits;
}

const omitsStatusCache = new Map<string, boolean>();

type EnvelopeSchemaLoader = Pick<
  typeof import('../validation/schema-loader'),
  'responseSchemaComposesEnvelope' | 'isExternalSchemaRootActive'
>;

let boundEnvelopeSchemaLoader: EnvelopeSchemaLoader | undefined;

/**
 * Called by `schema-loader` when it loads, so this module consults the loader
 * instance of its own module format. The schema loader is not imported here
 * directly, which keeps it (and AJV) out of this module's eager graph. A lazy
 * `require()` alone resolved the CommonJS build even from the ESM build, whose
 * registry does not see roots registered through the ESM loader
 * (`registerExternalSchemaRoot`, `withExternalSchemaRoot`), so an unpackaged
 * release looked unknown and kept `status` (adcp-client#3529).
 *
 * @internal
 */
export function bindEnvelopeSchemaLoader(loader: EnvelopeSchemaLoader): void {
  if (boundEnvelopeSchemaLoader !== loader) omitsStatusCache.clear();
  boundEnvelopeSchemaLoader = loader;
}

function envelopeSchemaLoader(): EnvelopeSchemaLoader {
  // Nothing registered a root through a loader that was never loaded, so
  // falling back to a fresh load sees the same bundles.
  return (
    boundEnvelopeSchemaLoader ??
    (require('../validation/schema-loader') as typeof import('../validation/schema-loader'))
  );
}

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
export function isLegacy30xPayload(payload: Record<string, unknown>): boolean {
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
 * status `completed` when `options.toolName` is `create_media_buy` or
 * `update_media_buy`. Pure function; safe to call before validation.
 *
 * @param response - The raw wire response object.
 * @param options - Optional task context. Pass `toolName` when normalizing a
 *   tool response so task-specific legacy body-status shims can run.
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
  // 3.0 emitters never served these tools. On 3.2 the schema forbids `status`;
  // on 3.3 a missing one is the seller's defect and must reach the validator.
  if (options?.toolName && COMPACT_SYNC_RESPONSE_TOOLS.has(options.toolName)) return response;

  if (
    options?.toolName &&
    MEDIA_BUY_STATUS_RESPONSE_TOOLS.has(options.toolName) &&
    allowsDeprecatedMediaBuyStatus(response) &&
    isMediaBuySuccessStatusForCompat(response, options)
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
    !isMediaBuySuccessStatusForCompat(response, options)
  ) {
    return response;
  }
  const status = getAuthoritativeMediaBuyStatus(withRequestedVersion(response, options));
  if (!status || response.media_buy_status === status) return response;
  return { ...response, media_buy_status: status } as T;
}

function isMediaBuySuccessStatusForCompat(
  response: Record<string, unknown>,
  options: LegacyEnvelopeStatusOptions | undefined
): boolean {
  const status = response.status;
  if (getAuthoritativeMediaBuyStatus(withRequestedVersion(response, options)) !== status) return false;
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

/**
 * View of `payload` for the TaskStatus/MediaBuyStatus ambiguity check: when
 * the seller did not echo a version, read it in the release the caller
 * requested or negotiated. Only used for classification; the returned object
 * never reaches the caller.
 */
function withRequestedVersion(
  payload: Record<string, unknown>,
  options: LegacyEnvelopeStatusOptions | undefined
): Record<string, unknown> {
  const requested = options?.adcpVersion;
  if (typeof requested !== 'string' || requested.length === 0) return payload;
  if (typeof payload.adcp_version === 'string' || typeof payload.adcp_major_version === 'number') return payload;
  return { ...payload, adcp_version: requested };
}
