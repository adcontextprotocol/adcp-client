import { ADCPError } from '../errors';
import type { SyncAccountsRequest } from '../types';
import type { MutatingRequestInput } from '../utils/idempotency';
import { getSchemaValidatorByRef } from '../validation/schema-loader';

type AccountSettings = Extract<SyncAccountsRequest['accounts'][number], { account: unknown }>;
export type AccountNotificationConfig = NonNullable<AccountSettings['notification_configs']>[number];
export type AccountChangeSubscriber = Omit<AccountNotificationConfig, 'event_types'> & {
  event_types?: AccountNotificationConfig['event_types'];
};

export class AccountChangeSubscriptionError extends ADCPError {
  readonly code = 'account_change_subscription_invalid';
  constructor(public readonly field: string) {
    super(`Invalid account change subscription at ${field}.`, { field });
  }
}

/**
 * Build a settings-only sync_accounts request from the complete current config
 * set. Merge by subscriber_id and retain sibling subscribers and event types.
 * The caller owns read/modify/write serialization and must check per-account
 * results/readback. This pure builder neither proves endpoint control nor
 * implements a persistent subscription runtime.
 */
export function buildAccountChangeSubscriptionRequest(options: {
  account: AccountSettings['account'];
  currentConfigs: readonly AccountNotificationConfig[];
  subscriber: AccountChangeSubscriber;
  idempotencyKey?: string;
}): MutatingRequestInput<SyncAccountsRequest> {
  if (!Array.isArray(options.currentConfigs)) throw new AccountChangeSubscriptionError('currentConfigs');
  const configs = structuredClone([...options.currentConfigs]);
  const validator = getSchemaValidatorByRef('core/notification-config.json');
  if (!validator) throw new Error('Bundled notification config schema is unavailable.');
  const seen = new Set<string>();
  for (const [index, config] of configs.entries()) {
    const subscriberId = config?.subscriber_id;
    if (!validator(config) || seen.has(subscriberId)) {
      throw new AccountChangeSubscriptionError(`currentConfigs[${index}]`);
    }
    seen.add(subscriberId);
  }
  const subscriber = structuredClone(options.subscriber);
  const index = configs.findIndex(config => config.subscriber_id === subscriber.subscriber_id);
  const previous = index === -1 ? undefined : configs[index];
  const merged: AccountNotificationConfig = {
    ...previous,
    ...subscriber,
    event_types: [
      ...new Set([
        ...(previous?.event_types ?? []),
        ...(subscriber.event_types ?? []),
        'account.change_recorded' as const,
      ]),
    ],
  };
  if (!validator(merged)) throw new AccountChangeSubscriptionError('subscriber');
  if (index === -1) configs.push(merged);
  else configs[index] = merged;
  return {
    accounts: [{ account: structuredClone(options.account), notification_configs: configs }],
    ...(options.idempotencyKey !== undefined && { idempotency_key: options.idempotencyKey }),
  };
}
