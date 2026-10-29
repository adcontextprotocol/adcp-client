/**
 * Buyer helper for AdCP 3.3 principal-level reporting subscriptions (experimental
 * `media_buy.reporting_subscriptions`): write the `reporting_subscriptions` section through
 * the guarded `sync_principal` lifecycle and read the subscriptions back.
 */
import type { ReportingSubscription, ReportingSubscriptionState } from '../types/core.generated';
import {
  PrincipalLifecycleError,
  syncPrincipalLifecycle,
  type PrincipalLifecycleClient,
  type PrincipalLifecycleOptions,
  type PrincipalLifecycleResult,
} from './lifecycle';

export interface SyncReportingSubscriptionsResultV1 extends PrincipalLifecycleResult {
  /** Readback for every subscription, including inactive ones whose obligations are retained. */
  subscriptions: ReportingSubscriptionState[];
}

/**
 * Replace the caller's complete reporting subscription set. Omitted subscriptions are
 * deactivated by the seller. Uses the same guarded replacement as
 * `syncPrincipalLifecycle` (expected_configuration_version, fresh idempotency keys on
 * conflict), then checks that every submitted subscription reads back at the submitted
 * version. Keep each submitted configuration by version: the readback carries only the
 * current one, and coverage needs every version's selector.
 */
export async function syncReportingSubscriptionsV1(
  client: PrincipalLifecycleClient,
  subscriptions: readonly ReportingSubscription[],
  options: PrincipalLifecycleOptions = {}
): Promise<SyncReportingSubscriptionsResultV1> {
  const result = await syncPrincipalLifecycle(
    client,
    { reporting_subscriptions: structuredClone([...subscriptions]) } as never,
    options
  );
  const states = (result.current.configuration.reporting_subscriptions ?? []) as ReportingSubscriptionState[];
  for (const subscription of subscriptions) {
    const state = states.find(item => item.subscription_id === subscription.subscription_id);
    if (!state || state.subscription_version !== subscription.subscription_version) {
      throw new PrincipalLifecycleError(
        `Seller readback does not carry subscription ${JSON.stringify(subscription.subscription_id)} at version ${subscription.subscription_version}`,
        { applied: result.applied, current: result.current }
      );
    }
    if ((subscription.active === false) !== (state.state === 'inactive')) {
      throw new PrincipalLifecycleError(
        `Seller readback for subscription ${JSON.stringify(subscription.subscription_id)} does not reflect active: ${subscription.active}`,
        { applied: result.applied, current: result.current }
      );
    }
  }
  return { ...result, subscriptions: structuredClone(states) };
}
