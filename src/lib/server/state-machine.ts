import type { MediaBuyStatus, CreativeStatus } from '../types/core.generated';
import { adcpError } from './errors';

/**
 * Canonical AdCP MediaBuy status transition graph.
 *
 * Source of truth: `static/schemas/source/enums/media-buy-status.json`.
 * The conformance runner enforces `status.monotonic` using this same graph;
 * keeping one copy here prevents seller implementations from drifting out
 * of sync with the runner's enforcement.
 *
 * NOTE: `pending_start → rejected` is defensible but not explicit in the
 * schema prose. Kept for parity with the runner; flagged for spec
 * clarification.
 */
export const MEDIA_BUY_TRANSITIONS: ReadonlyMap<MediaBuyStatus, ReadonlySet<MediaBuyStatus>> = new Map([
  ['pending_creatives', new Set<MediaBuyStatus>(['pending_start', 'active', 'paused', 'canceled', 'rejected'])],
  ['pending_start', new Set<MediaBuyStatus>(['active', 'paused', 'canceled', 'rejected'])],
  ['active', new Set<MediaBuyStatus>(['paused', 'completed', 'canceled'])],
  ['paused', new Set<MediaBuyStatus>(['active', 'completed', 'canceled'])],
  ['completed', new Set<MediaBuyStatus>()],
  ['rejected', new Set<MediaBuyStatus>()],
  ['canceled', new Set<MediaBuyStatus>()],
]);

/**
 * Canonical AdCP CreativeAsset status transition graph.
 *
 * Source of truth: `static/schemas/source/enums/creative-status.json`.
 * `approved ↔ archived` is reversible (buyer archives / unarchives).
 * `rejected → processing` is allowed on re-sync.
 */
export const CREATIVE_ASSET_TRANSITIONS: ReadonlyMap<CreativeStatus, ReadonlySet<CreativeStatus>> = new Map([
  ['processing', new Set<CreativeStatus>(['pending_review', 'rejected'])],
  ['pending_review', new Set<CreativeStatus>(['approved', 'rejected'])],
  ['approved', new Set<CreativeStatus>(['archived', 'rejected'])],
  ['archived', new Set<CreativeStatus>(['approved'])],
  ['rejected', new Set<CreativeStatus>(['processing', 'pending_review'])],
]);

export function isLegalMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus): boolean {
  return MEDIA_BUY_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Assert that a MediaBuy status transition is legal, throwing the
 * spec-mandated AdCP error code if not.
 *
 * - `canceled → canceled`: throws `NOT_CANCELLABLE` (idempotency-on-cancel)
 * - Any other illegal edge: throws `INVALID_STATE`
 *
 * The returned error is an `AdcpErrorResponse` shaped for direct `throw`
 * from a tool handler — the `createAdcpServer` framework auto-unwraps it.
 *
 * @param from     Current status of the media buy.
 * @param to       Desired target status.
 * @param mediaBuyId  Optional ID included in the error message for diagnostics.
 */
export function assertMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus, mediaBuyId?: string): void {
  if (isLegalMediaBuyTransition(from, to)) return;
  const label = mediaBuyId ? `Media buy ${mediaBuyId}` : 'Media buy';
  if (from === 'canceled' && to === 'canceled') {
    throw adcpError('NOT_CANCELLABLE', {
      message: `${label} is already canceled; canceled is terminal.`,
      recovery: 'terminal',
    });
  }
  throw adcpError('INVALID_STATE', {
    message: `${label}: illegal status transition ${from} → ${to}.`,
    field: 'status',
    recovery: 'terminal',
  });
}

export function isLegalCreativeTransition(from: CreativeStatus, to: CreativeStatus): boolean {
  return CREATIVE_ASSET_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Assert that a Creative status transition is legal, throwing the
 * spec-mandated AdCP error code if not.
 *
 * @param from       Current status of the creative.
 * @param to         Desired target status.
 * @param creativeId  Optional ID included in the error message for diagnostics.
 */
export function assertCreativeTransition(from: CreativeStatus, to: CreativeStatus, creativeId?: string): void {
  if (isLegalCreativeTransition(from, to)) return;
  const label = creativeId ? `Creative ${creativeId}` : 'Creative';
  throw adcpError('INVALID_STATE', {
    message: `${label}: illegal status transition ${from} → ${to}.`,
    field: 'status',
    recovery: 'terminal',
  });
}
