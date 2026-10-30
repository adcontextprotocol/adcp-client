/**
 * Buyer helper for AdCP 3.3 principal-level reporting subscriptions (experimental
 * `media_buy.reporting_subscriptions`): write the `reporting_subscriptions` section through
 * the guarded `sync_principal` lifecycle and read the subscriptions back.
 */
import { ReportingSubscriptionError } from '../errors';
import type { ReportingSubscription, ReportingSubscriptionState } from '../types/core.generated';
import {
  PrincipalLifecycleError,
  guardedSyncPrincipalLifecycle,
  type PrincipalLifecycleClient,
  type PrincipalLifecycleOptions,
  type PrincipalLifecycleResult,
} from './lifecycle';

export interface SyncReportingSubscriptionsResultV1 extends PrincipalLifecycleResult {
  /** Readback for every subscription, including inactive ones whose obligations are retained. */
  subscriptions: ReportingSubscriptionState[];
}

export interface SyncReportingSubscriptionsOptionsV1 extends PrincipalLifecycleOptions {
  /**
   * Allow the write to deactivate a currently active subscription by omitting it. Defaults to
   * false: deactivation is a cutover that cannot be undone retroactively, so a filtered list
   * is refused before anything is written. Sending a subscription with `active: false` is an
   * explicit deactivation and is always allowed.
   */
  allowDeactivation?: boolean;
}

/**
 * Replace the caller's complete reporting subscription set.
 *
 * Throws {@link ReportingSubscriptionError}: `SUBSCRIPTION_WOULD_DEACTIVATE` (with `dispatched: false`
 * when nothing was sent), `SUBSCRIPTION_CONFLICT_EXHAUSTED`, or `SUBSCRIPTION_READBACK_MISMATCH`.
 * Other lifecycle failures throw `PrincipalLifecycleError`.
 * Uses the same guarded
 * replacement as `syncPrincipalLifecycle` (expected_configuration_version, fresh idempotency
 * keys on conflict). Omitting a currently active subscription deactivates it, so that is
 * refused unless `allowDeactivation` is set; the check runs against every configuration read
 * the write replaces, including the fresh read after a conflict. After the write, every
 * submitted subscription must read back at the submitted version, with the submitted active
 * state and with every submitted configuration field unchanged.
 *
 * Keep each submitted configuration by version. A seller on 3.3.0-beta.2 or later also
 * returns it in `prior_versions[].configuration` (adcp#8588).
 */
export async function syncReportingSubscriptionsV1(
  client: PrincipalLifecycleClient,
  subscriptions: readonly ReportingSubscription[],
  options: SyncReportingSubscriptionsOptionsV1 = {}
): Promise<SyncReportingSubscriptionsResultV1> {
  const { allowDeactivation = false, ...lifecycleOptions } = options;
  const submittedIds = new Set(subscriptions.map(subscription => subscription.subscription_id));
  let result: PrincipalLifecycleResult;
  try {
    result = await guardedSyncPrincipalLifecycle(
      client,
      { reporting_subscriptions: structuredClone([...subscriptions]) } as never,
      lifecycleOptions,
      (prior, { written }) => {
        if (allowDeactivation || prior.kind !== 'current') return;
        const current = (prior.configuration as { reporting_subscriptions?: ReportingSubscriptionState[] })
          .reporting_subscriptions;
        const omitted = (current ?? [])
          .filter(state => state.state !== 'inactive' && !submittedIds.has(state.subscription_id))
          .map(state => state.subscription_id);
        if (omitted.length > 0) {
          throw new ReportingSubscriptionError(
            'SUBSCRIPTION_WOULD_DEACTIVATE',
            `The write would deactivate active subscriptions it omits (${omitted.map(id => JSON.stringify(id)).join(', ')}), because reporting_subscriptions is the complete set. Include them, send them with active: false, or pass allowDeactivation: true.`,
            { wouldDeactivate: omitted, ...(written ? {} : { dispatched: false as const }) }
          );
        }
      }
    );
  } catch (error) {
    if (error instanceof PrincipalLifecycleError && error.code === 'PRINCIPAL_CONFLICT_EXHAUSTED') {
      throw new ReportingSubscriptionError(
        'SUBSCRIPTION_CONFLICT_EXHAUSTED',
        `${error.message} Another writer is updating this principal; retry later.`,
        { cause: error }
      );
    }
    throw error;
  }
  const states = (result.current.configuration.reporting_subscriptions ?? []) as ReportingSubscriptionState[];
  for (const subscription of subscriptions) {
    const state = states.find(item => item.subscription_id === subscription.subscription_id);
    const fail = (message: string) =>
      new ReportingSubscriptionError(
        'SUBSCRIPTION_READBACK_MISMATCH',
        `${message}. The seller altered a submitted field; contact the seller.`,
        { readback: state, appliedResponse: result.applied, current: result.current }
      );
    if (!state || state.subscription_version !== subscription.subscription_version) {
      throw fail(
        `Seller readback does not carry subscription ${JSON.stringify(subscription.subscription_id)} at version ${subscription.subscription_version}`
      );
    }
    if ((subscription.active === false) !== (state.state === 'inactive')) {
      throw fail(
        `Seller readback for subscription ${JSON.stringify(subscription.subscription_id)} does not reflect active: ${subscription.active}`
      );
    }
    const { active: _active, ...submitted } = subscription;
    const { active: _readActive, ...stored } = (state.configuration ?? {}) as Partial<ReportingSubscription>;
    const differing = differingPath(submitted, stored, '');
    if (differing !== undefined) {
      throw fail(
        `Seller readback for subscription ${JSON.stringify(subscription.subscription_id)} stores a different configuration at ${differing || '/'}`
      );
    }
  }
  return { ...result, subscriptions: structuredClone(states) };
}

/**
 * The first path at which `stored` lacks or changes a value the buyer sent. Fields the seller
 * adds (defaults it fills) are ignored; arrays must match element for element.
 */
function differingPath(sent: unknown, stored: unknown, path: string): string | undefined {
  if (Array.isArray(sent)) {
    if (!Array.isArray(stored) || stored.length !== sent.length) return path;
    for (let index = 0; index < sent.length; index += 1) {
      const differing = differingPath(sent[index], stored[index], `${path}/${index}`);
      if (differing !== undefined) return differing;
    }
    return undefined;
  }
  if (sent !== null && typeof sent === 'object') {
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return path;
    for (const [key, value] of Object.entries(sent)) {
      if (value === undefined) continue;
      const differing = differingPath(value, (stored as Record<string, unknown>)[key], `${path}/${key}`);
      if (differing !== undefined) return differing;
    }
    return undefined;
  }
  return Object.is(sent, stored) ? undefined : path;
}
