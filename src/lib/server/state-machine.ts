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
 *
 * @public
 */

import type { CreativeStatus, MediaBuyStatus } from '../types/core.generated';
import { AdcpError } from './decisioning/async-outcome';

/**
 * Legal `MediaBuyStatus` transitions per `media-buy-status.json`.
 *
 * `active ↔ paused` is reversible (buyer pauses, seller resumes).
 * `completed | rejected | canceled` are terminal — no outbound edges.
 *
 * `pending_start → rejected` is supported because the schema's prose
 * (`"declined by the seller after creation"`) does not exclude post-start
 * rejection. Storyboards do not exercise that edge today; sellers MAY
 * narrow it in their own enforcement if their upstream forbids it.
 */
export const MEDIA_BUY_TRANSITIONS: ReadonlyMap<MediaBuyStatus, ReadonlySet<MediaBuyStatus>> = new Map<
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
export function isLegalMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus): boolean {
  return MEDIA_BUY_TRANSITIONS.get(from)?.has(to) ?? false;
}

/** Boolean predicate for `CreativeStatus` transitions. Self-edges are illegal. */
export function isLegalCreativeTransition(from: CreativeStatus, to: CreativeStatus): boolean {
  return CREATIVE_ASSET_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Throws an `AdcpError` with the spec-correct error code for an illegal
 * `MediaBuyStatus` transition.
 *
 * Code selection mirrors the storyboard's expectations:
 *   - `canceled → canceled`: `NOT_CANCELLABLE`. The schema reserves this
 *     code for the cancellation idempotency path (buyer cancels twice;
 *     the second call is the duplicate). See
 *     `compliance/cache/<version>/protocols/media-buy/state-machine.yaml`
 *     and `invalid_transitions.yaml`.
 *   - Anything else: `INVALID_STATE`. This includes other terminal-state
 *     escapes (`canceled → paused`, `completed → active`, etc.) — those
 *     are illegal lifecycle moves, not idempotent cancellations, so
 *     `NOT_CANCELLABLE` is the wrong code. `INVALID_STATE` is the
 *     spec-defined catch-all for "request well-formed, current resource
 *     state forbids it."
 *
 * Both codes carry `recovery: 'terminal'` per `STANDARD_ERROR_CODES`.
 */
export function assertMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus): void {
  if (isLegalMediaBuyTransition(from, to)) return;
  if (from === 'canceled' && to === 'canceled') {
    throw new AdcpError('NOT_CANCELLABLE', {
      message: 'Media buy is already canceled; canceled is terminal.',
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
