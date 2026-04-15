/**
 * Media buy response helpers that eliminate common implementation traps.
 *
 * These helpers encode protocol rules (status→valid_actions mapping,
 * required cancellation metadata, initial revision numbers) so agent
 * builders get the right shape by default.
 */

import type { MediaBuyStatus, CanceledBy, CreateMediaBuySuccess, Package } from '../types/core.generated';

/**
 * Actions a buyer can perform on a media buy.
 * Derived from the generated schema to stay in sync automatically.
 */
export type ValidAction = NonNullable<CreateMediaBuySuccess['valid_actions']>[number];

/**
 * Returns the default set of valid buyer actions for a given media buy status.
 *
 * Terminal statuses (completed, rejected, canceled) return an empty array.
 * Active statuses return the full set of actions; paused restricts to
 * resume, cancel, and budget/date updates.
 *
 * Both pending statuses allow full modification — the protocol permits
 * restructuring a buy (packages, budget, dates) while awaiting creatives
 * or start date.
 *
 * Sellers with restricted capabilities can filter the result:
 * ```typescript
 * const actions = validActionsForStatus('active')
 *   .filter(a => a !== 'sync_creatives'); // no creative management
 * ```
 */
export function validActionsForStatus(status: MediaBuyStatus): ValidAction[] {
  switch (status) {
    case 'pending_creatives':
    case 'pending_start':
      return ['cancel', 'update_budget', 'update_dates', 'update_packages', 'add_packages', 'sync_creatives'];
    case 'active':
      return [
        'pause',
        'cancel',
        'update_budget',
        'update_dates',
        'update_packages',
        'add_packages',
        'sync_creatives',
      ];
    case 'paused':
      return ['resume', 'cancel', 'update_budget', 'update_dates'];
    case 'completed':
    case 'rejected':
    case 'canceled':
      return [];
  }
}

/**
 * Input for cancelMediaBuyResponse(). Requires the fields that agent builders
 * commonly forget — canceled_by and revision are mandatory,
 * canceled_at defaults to now.
 */
export interface CancelMediaBuyInput {
  media_buy_id: string;
  canceled_by: CanceledBy;
  /** Current revision after the cancellation update. */
  revision: number;
  reason?: string;
  canceled_at?: string;
  affected_packages?: Package[];
  sandbox?: boolean;
}
