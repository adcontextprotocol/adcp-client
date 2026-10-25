/**
 * Canonical lifecycle graphs for resources whose status enums the spec
 * publishes. Single source of truth — the storyboard runner's
 * `status.monotonic` invariant in `testing/storyboard/default-invariants.ts`
 * imports the same maps, so a seller that enforces transitions with these
 * helpers cannot drift from the conformance-runner enforcement.
 *
 * Edges mirror the prose in `static/schemas/source/enums/<resource>-status.json`.
 * `active ↔ paused` (media buy), `approved ↔ archived` (creative), and the
 * `rejected → processing | pending_review` re-sync path are all explicit per
 * the spec; everything else is derived from the published lifecycle.
 *
 * Two surfaces per resource:
 *   - `isLegalXTransition(from, to)` — boolean predicate. Use when you
 *     want to wrap the failure in your own error type (test-controller
 *     code, custom audit shapes).
 *   - `assertXTransition(from, to)` — throws an `AdcpError` with the
 *     spec-correct `code`. For media buys this is `NOT_CANCELLABLE` on
 *     the re-cancel idempotency path and `INVALID_STATE` everywhere else.
 *     Production seller code that handles the wire protocol directly
 *     should use this — the framework projects `AdcpError` onto the
 *     wire `adcp_error` envelope automatically.
 * Media-buy helpers accept the served AdCP version as a third argument;
 * `getMediaBuyTransitions(version)` selects the same graph for custom consumers.
 *
 * @public
 */

import type { CreativeStatus, MediaBuyStatus } from '../types/core.generated';
import { ADCP_VERSION } from '../version';
import { isAdcpVersionAtLeast } from '../utils/adcp-version-config';
import { AdcpError } from './decisioning/async-outcome';

/**
 * Legal `MediaBuyStatus` transitions per `media-buy-status.json`.
 *
 * `active ↔ paused` is reversible (buyer pauses, seller resumes).
 * `completed | rejected | canceled` are terminal — no outbound edges.
 *
 * `pending_start → rejected` covers seller rejection during setup after the
 * buy is created. It does not permit rejection of an already active buy.
 */
const LEGACY_MEDIA_BUY_TRANSITIONS: ReadonlyMap<MediaBuyStatus, ReadonlySet<MediaBuyStatus>> = new Map<
  MediaBuyStatus,
  ReadonlySet<MediaBuyStatus>
>([
  ['pending_creatives', new Set(['pending_start', 'active', 'paused', 'canceled', 'rejected'])],
  ['pending_start', new Set(['active', 'paused', 'canceled', 'rejected'])],
  ['active', new Set(['paused', 'completed', 'canceled'])],
  ['paused', new Set(['active', 'completed', 'canceled'])],
  ['completed', new Set()],
  ['rejected', new Set()],
  ['canceled', new Set()],
]);

const CREATIVE_REVIEW_MEDIA_BUY_TRANSITIONS: ReadonlyMap<MediaBuyStatus, ReadonlySet<MediaBuyStatus>> = new Map([
  ...LEGACY_MEDIA_BUY_TRANSITIONS,
  [
    'pending_start',
    new Set<MediaBuyStatus>(['pending_creatives', ...LEGACY_MEDIA_BUY_TRANSITIONS.get('pending_start')!]),
  ],
]);

/**
 * Lifecycle graph for the served AdCP release. In 3.3, a seller review rejection
 * can introduce buyer work before activation: `pending_start → pending_creatives`.
 * Older releases keep their published graph. Active/paused buys cannot rewind.
 * Accepts full-semver or release-precision versions, including 3.3 candidates.
 */
export function getMediaBuyTransitions(
  adcpVersion = ADCP_VERSION
): ReadonlyMap<MediaBuyStatus, ReadonlySet<MediaBuyStatus>> {
  return isAdcpVersionAtLeast(adcpVersion, '3.3-beta')
    ? CREATIVE_REVIEW_MEDIA_BUY_TRANSITIONS
    : LEGACY_MEDIA_BUY_TRANSITIONS;
}

/** Lifecycle graph for the SDK's default AdCP release. */
export const MEDIA_BUY_TRANSITIONS = getMediaBuyTransitions();

/**
 * Legal `CreativeStatus` transitions per `creative-status.json`.
 *
 * `processing → approved` is NOT a direct edge — the spec defines
 * `processing → pending_review | rejected`, and review is what produces
 * the `approved` state. `rejected → processing | pending_review` covers
 * the buyer's re-sync path (re-submit via `sync_creatives`). No states
 * are terminal — every state can recover via re-sync.
 */
export const CREATIVE_ASSET_TRANSITIONS: ReadonlyMap<CreativeStatus, ReadonlySet<CreativeStatus>> = new Map<
  CreativeStatus,
  ReadonlySet<CreativeStatus>
>([
  ['processing', new Set(['pending_review', 'rejected'])],
  ['pending_review', new Set(['approved', 'rejected'])],
  ['approved', new Set(['archived', 'rejected'])],
  ['archived', new Set(['approved'])],
  ['rejected', new Set(['processing', 'pending_review'])],
]);

/** Boolean predicate for `MediaBuyStatus` transitions. Self-edges are illegal. */
export function isLegalMediaBuyTransition(
  from: MediaBuyStatus,
  to: MediaBuyStatus,
  adcpVersion = ADCP_VERSION
): boolean {
  return getMediaBuyTransitions(adcpVersion).get(from)?.has(to) ?? false;
}

/** Boolean predicate for `CreativeStatus` transitions. Self-edges are illegal. */
export function isLegalCreativeTransition(from: CreativeStatus, to: CreativeStatus): boolean {
  return CREATIVE_ASSET_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Throws an `AdcpError` with the spec-correct error code for an illegal
 * `MediaBuyStatus` transition.
 *
 * Code selection per `compliance/cache/<version>/protocols/media-buy/state-machine.yaml`:
 * _"The cancellation-specific code takes precedence over the generic
 * INVALID_STATE when the attempted action is cancel; non-cancel actions
 * targeting or out of terminal states still return INVALID_STATE."_
 *
 *   - Any illegal transition where `to === 'canceled'` (i.e. the buyer was
 *     attempting a cancel that the current state forbids — `completed →
 *     canceled`, `rejected → canceled`, the double-cancel idempotency
 *     `canceled → canceled`): `NOT_CANCELLABLE`.
 *   - Any other illegal edge (terminal-state escapes like `canceled →
 *     paused`, `completed → active`, lifecycle skips): `INVALID_STATE`.
 *
 * Both codes carry `recovery: 'correctable'` per the manifest in
 * `STANDARD_ERROR_CODES` — the buyer can adjust their request (re-fetch
 * current state, choose a different action) rather than escalating.
 */
export function assertMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus, adcpVersion = ADCP_VERSION): void {
  if (isLegalMediaBuyTransition(from, to, adcpVersion)) return;
  if (to === 'canceled') {
    throw new AdcpError('NOT_CANCELLABLE', {
      message: `Media buy in ${from} state cannot be canceled.`,
      field: 'status',
    });
  }
  throw new AdcpError('INVALID_STATE', {
    message: `Illegal MediaBuy transition: ${from} → ${to}.`,
    field: 'status',
  });
}

/**
 * Throws an `AdcpError('INVALID_STATE')` for an illegal `CreativeStatus`
 * transition. Creatives have no terminals — every state can recover via
 * re-sync — so there is no creative analogue to `NOT_CANCELLABLE`.
 */
export function assertCreativeTransition(from: CreativeStatus, to: CreativeStatus): void {
  if (isLegalCreativeTransition(from, to)) return;
  throw new AdcpError('INVALID_STATE', {
    message: `Illegal Creative transition: ${from} → ${to}.`,
    field: 'status',
  });
}
