/**
 * Canonical AdCP state-machine transition maps for server-side enforcement.
 *
 * These maps are the single source of truth for which status transitions are
 * legal. The conformance runner's `status.monotonic` invariant uses the same
 * maps, so sellers who guard their handlers with `assertMediaBuyTransition` /
 * `assertCreativeTransition` are guaranteed to agree with the runner.
 *
 * ## Usage in production handlers
 *
 * ```ts
 * import { assertMediaBuyTransition, assertCreativeTransition } from '@adcp/sdk/server';
 *
 * // cancel_media_buy handler:
 * assertMediaBuyTransition(buy.status, 'canceled');
 * // → throws AdcpError('NOT_CANCELLABLE') if buy is already in a terminal state
 * // → throws AdcpError('INVALID_STATE')   for any other illegal transition
 *
 * // update_media_buy handler (status change):
 * assertMediaBuyTransition(buy.status, newStatus);
 * ```
 *
 * ## Usage in test controllers
 *
 * Test controllers throw `TestControllerError`, not `AdcpError`. Use the
 * boolean predicate `isLegalMediaBuyTransition` and throw `TestControllerError`
 * yourself:
 *
 * ```ts
 * import { isLegalMediaBuyTransition } from '@adcp/sdk/server';
 * import { TestControllerError } from '@adcp/sdk/testing';
 *
 * if (!isLegalMediaBuyTransition(prev, status))
 *   throw new TestControllerError('INVALID_TRANSITION', `${prev} → ${status}`, prev);
 * ```
 */

import { AdcpError } from './decisioning/async-outcome';
import type { MediaBuyStatus, CreativeStatus, CreativeApprovalStatus } from '../types/core.generated';

// ---------------------------------------------------------------------------
// MediaBuy state machine
// ---------------------------------------------------------------------------

/**
 * Legal MediaBuy status transitions per AdCP 3.0.
 *
 * `active ↔ paused` is reversible. `completed | rejected | canceled` are
 * terminal — no outbound edges.
 *
 * Note: `pending_start → rejected` is defensible but not explicit in the
 * schema prose — `rejected` is described as "declined by the seller after
 * creation", which is ambiguous on whether post-start rejection is in scope.
 * Kept for now; flagged in adcp#3121 for spec clarification.
 */
export const MEDIA_BUY_TRANSITIONS: ReadonlyMap<MediaBuyStatus, ReadonlySet<MediaBuyStatus>> = new Map<
  MediaBuyStatus,
  ReadonlySet<MediaBuyStatus>
>([
  ['pending_creatives', new Set<MediaBuyStatus>(['pending_start', 'active', 'paused', 'canceled', 'rejected'])],
  ['pending_start', new Set<MediaBuyStatus>(['active', 'paused', 'canceled', 'rejected'])],
  ['active', new Set<MediaBuyStatus>(['paused', 'completed', 'canceled'])],
  ['paused', new Set<MediaBuyStatus>(['active', 'completed', 'canceled'])],
  ['completed', new Set<MediaBuyStatus>()],
  ['rejected', new Set<MediaBuyStatus>()],
  ['canceled', new Set<MediaBuyStatus>()],
]);

/** Returns `true` if the `from → to` MediaBuy transition is legal. */
export function isLegalMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus): boolean {
  return MEDIA_BUY_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Asserts that the `from → to` MediaBuy transition is legal.
 *
 * Throws `AdcpError` on failure:
 * - `NOT_CANCELLABLE` — `to` is `'canceled'` but `from` is a terminal state
 *   (the buy is already completed, rejected, or canceled)
 * - `INVALID_STATE` — any other illegal transition
 *
 * For test-controller methods (which must throw `TestControllerError`), use
 * `isLegalMediaBuyTransition` + `TestControllerError` instead.
 */
export function assertMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus): void {
  if (isLegalMediaBuyTransition(from, to)) return;
  if (to === 'canceled') {
    throw new AdcpError('NOT_CANCELLABLE', {
      message: `Media buy cannot be canceled; it is already in a terminal state ('${from}').`,
    });
  }
  throw new AdcpError('INVALID_STATE', {
    message: `Illegal media buy transition: '${from}' → '${to}'.`,
    field: 'status',
  });
}

// ---------------------------------------------------------------------------
// Creative asset state machine
// ---------------------------------------------------------------------------

/**
 * Legal CreativeAsset status transitions per AdCP 3.0.
 *
 * Key edges:
 * - `processing` only advances to `pending_review` (success) or `rejected`
 *   (processing failure) — no direct `processing → approved` edge.
 * - `rejected` is recoverable: buyer re-submits via `sync_creatives`, which
 *   moves the creative back to `processing` or directly to `pending_review`.
 * - `approved ↔ archived` is reversible (buyer archives / unarchives).
 */
export const CREATIVE_ASSET_TRANSITIONS: ReadonlyMap<CreativeStatus, ReadonlySet<CreativeStatus>> = new Map<
  CreativeStatus,
  ReadonlySet<CreativeStatus>
>([
  ['processing', new Set<CreativeStatus>(['pending_review', 'rejected'])],
  ['pending_review', new Set<CreativeStatus>(['approved', 'rejected'])],
  ['approved', new Set<CreativeStatus>(['archived', 'rejected'])],
  ['archived', new Set<CreativeStatus>(['approved'])],
  ['rejected', new Set<CreativeStatus>(['processing', 'pending_review'])],
]);

/** Returns `true` if the `from → to` CreativeAsset transition is legal. */
export function isLegalCreativeTransition(from: CreativeStatus, to: CreativeStatus): boolean {
  return CREATIVE_ASSET_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Asserts that the `from → to` CreativeAsset transition is legal.
 * Throws `AdcpError('INVALID_STATE')` on failure.
 *
 * For test-controller methods, use `isLegalCreativeTransition` +
 * `TestControllerError` instead.
 */
export function assertCreativeTransition(from: CreativeStatus, to: CreativeStatus): void {
  if (isLegalCreativeTransition(from, to)) return;
  throw new AdcpError('INVALID_STATE', {
    message: `Illegal creative asset transition: '${from}' → '${to}'.`,
    field: 'status',
  });
}

// ---------------------------------------------------------------------------
// Creative approval state machine (per-package assignment approval_status)
// ---------------------------------------------------------------------------

/**
 * Legal CreativeApproval status transitions per AdCP 3.0.
 *
 * Per-assignment approval state on a package. `rejected → pending_review`
 * is allowed on re-sync.
 */
export const CREATIVE_APPROVAL_TRANSITIONS: ReadonlyMap<
  CreativeApprovalStatus,
  ReadonlySet<CreativeApprovalStatus>
> = new Map<CreativeApprovalStatus, ReadonlySet<CreativeApprovalStatus>>([
  ['pending_review', new Set<CreativeApprovalStatus>(['approved', 'rejected'])],
  ['approved', new Set<CreativeApprovalStatus>(['rejected'])],
  ['rejected', new Set<CreativeApprovalStatus>(['pending_review'])],
]);

/** Returns `true` if the `from → to` CreativeApproval transition is legal. */
export function isLegalCreativeApprovalTransition(from: CreativeApprovalStatus, to: CreativeApprovalStatus): boolean {
  return CREATIVE_APPROVAL_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Asserts that the `from → to` CreativeApproval transition is legal.
 * Throws `AdcpError('INVALID_STATE')` on failure.
 */
export function assertCreativeApprovalTransition(from: CreativeApprovalStatus, to: CreativeApprovalStatus): void {
  if (isLegalCreativeApprovalTransition(from, to)) return;
  throw new AdcpError('INVALID_STATE', {
    message: `Illegal creative approval transition: '${from}' → '${to}'.`,
    field: 'approval_status',
  });
}
