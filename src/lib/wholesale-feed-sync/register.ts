import { ADCPError, ConfigurationError } from '../errors';
import type { SingleAgentClient } from '../core/SingleAgentClient';
import type { SyncAccountsRequest } from '../types';
import type { MutatingRequestInput } from '../utils/idempotency';
import { getSchemaValidatorByRef } from '../validation/schema-loader';

type AccountSettings = Extract<SyncAccountsRequest['accounts'][number], { account: unknown }>;
type AccountNotificationConfig = NonNullable<AccountSettings['notification_configs']>[number];

const WHOLESALE_FEED_EVENT_TYPES = [
  'product.created',
  'product.updated',
  'product.priced',
  'product.removed',
  'signal.created',
  'signal.updated',
  'signal.priced',
  'signal.removed',
  'wholesale_feed.bulk_change',
] as const;
const WHOLESALE_FEED_EVENT_TYPE_SET = new Set<string>(WHOLESALE_FEED_EVENT_TYPES);

export type WholesaleFeedWebhookEventType = (typeof WHOLESALE_FEED_EVENT_TYPES)[number];

export type WholesaleFeedWebhookSubscriber = Omit<AccountNotificationConfig, 'event_types' | 'product_payload_view'> & {
  /** Complete desired wholesale-feed event selection for this subscriber. */
  event_types: [WholesaleFeedWebhookEventType, ...WholesaleFeedWebhookEventType[]];
};

export interface WholesaleFeedWebhookRegistrationClient {
  syncAccounts: SingleAgentClient['syncAccounts'];
}

export interface RegisterWholesaleFeedWebhooksOptions {
  account: AccountSettings['account'];
  /**
   * Complete latest `notification_configs` readback for this account.
   * `sync_accounts` declaratively replaces the whole array; requiring the
   * current set lets this helper preserve sibling subscribers.
   */
  currentConfigs: readonly AccountNotificationConfig[];
  subscriber: WholesaleFeedWebhookSubscriber;
  /** Optional optimistic account revision from the latest account readback. */
  revision?: number;
  idempotencyKey?: string;
}

export class WholesaleFeedWebhookRegistrationError extends ADCPError {
  readonly code = 'wholesale_feed_webhook_registration_invalid';
  constructor(public readonly field: string) {
    super(`Invalid wholesale feed webhook registration at ${field}.`, { field });
  }
}

/**
 * Register or replace one account-scoped wholesale-feed webhook subscriber.
 *
 * `sync_accounts.accounts[].notification_configs` is a declarative-replace
 * surface. This helper performs a caller-owned read/modify/write: it preserves
 * sibling subscribers and non-wholesale events on the matching subscriber,
 * while replacing that subscriber's complete wholesale-feed event selection.
 * Callers must serialize concurrent changes and inspect the per-account result.
 *
 * Product registrations always request the legacy payload view consumed by
 * {@link WholesaleFeedSync.applyWebhook}; canonical product payloads belong to
 * the `list_products` mirror surface and are rejected by this helper.
 */
export function registerWholesaleFeedWebhooks(
  client: WholesaleFeedWebhookRegistrationClient,
  options: RegisterWholesaleFeedWebhooksOptions
): ReturnType<SingleAgentClient['syncAccounts']> {
  if (!client || typeof client.syncAccounts !== 'function') {
    throw new WholesaleFeedWebhookRegistrationError('client.syncAccounts');
  }
  if (!Array.isArray(options.currentConfigs)) {
    throw new WholesaleFeedWebhookRegistrationError('currentConfigs');
  }

  const validator = getSchemaValidatorByRef('core/notification-config.json');
  if (!validator) throw new ConfigurationError('Bundled notification config schema is unavailable.', 'schemas');

  const configs = structuredClone([...options.currentConfigs]);
  const seen = new Set<string>();
  for (const [index, config] of configs.entries()) {
    const subscriberId = config?.subscriber_id;
    if (!validator(config) || seen.has(subscriberId)) {
      throw new WholesaleFeedWebhookRegistrationError(`currentConfigs[${index}]`);
    }
    seen.add(subscriberId);
  }

  const subscriber = structuredClone(options.subscriber);
  if (!subscriber || typeof subscriber !== 'object' || !Array.isArray(subscriber.event_types)) {
    throw new WholesaleFeedWebhookRegistrationError('subscriber');
  }
  for (const key of Object.keys(subscriber) as (keyof WholesaleFeedWebhookSubscriber)[]) {
    if (subscriber[key] === undefined) delete subscriber[key];
  }
  if (
    subscriber.event_types.length === 0 ||
    new Set(subscriber.event_types).size !== subscriber.event_types.length ||
    subscriber.event_types.some(eventType => !WHOLESALE_FEED_EVENT_TYPE_SET.has(eventType))
  ) {
    throw new WholesaleFeedWebhookRegistrationError('subscriber.event_types');
  }

  const index = configs.findIndex(config => config.subscriber_id === subscriber.subscriber_id);
  const previous = index === -1 ? undefined : configs[index];
  if (previous && previous.url !== subscriber.url && previous.authentication && !subscriber.authentication) {
    throw new WholesaleFeedWebhookRegistrationError('subscriber.authentication');
  }

  const nonWholesaleEventTypes = (previous?.event_types ?? []).filter(
    (eventType: string) => !WHOLESALE_FEED_EVENT_TYPE_SET.has(eventType)
  );
  const eventTypes = [...nonWholesaleEventTypes, ...subscriber.event_types];
  const hasProductEvents = subscriber.event_types.some(eventType => eventType.startsWith('product.'));
  const merged: AccountNotificationConfig = {
    ...previous,
    ...subscriber,
    event_types: eventTypes as AccountNotificationConfig['event_types'],
    ...(hasProductEvents && { product_payload_view: 'legacy' as const }),
  };
  if (!hasProductEvents) delete merged.product_payload_view;
  if (!validator(merged)) throw new WholesaleFeedWebhookRegistrationError('subscriber');

  if (index === -1) {
    if (configs.length >= 16) throw new WholesaleFeedWebhookRegistrationError('currentConfigs');
    configs.push(merged);
  } else {
    configs[index] = merged;
  }

  const request: MutatingRequestInput<SyncAccountsRequest> = {
    accounts: [
      {
        account: structuredClone(options.account),
        ...(options.revision !== undefined && { revision: options.revision }),
        notification_configs: configs,
      },
    ],
    ...(options.idempotencyKey !== undefined && { idempotency_key: options.idempotencyKey }),
  };
  return client.syncAccounts(request);
}
