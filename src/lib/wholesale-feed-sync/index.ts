// WholesaleFeedSync — in-memory mirror of an AdCP agent's wholesale product and
// signal feeds. Discovers the agent's wholesale-feed capabilities at start() and
// picks the highest-capability sync strategy the agent supports (auto-poll
// conditional fetch or manual bootstrap).
//
// Companion to the AdCP 3.1 wholesale feed surfaces. Activates against 3.1+
// agents that declare `wholesale_feed_versioning` and/or
// `wholesale_feed_webhooks`; falls back to manual-mode bootstrap against 3.0
// agents.

export { WholesaleFeedSync } from './sync';
export { registerWholesaleFeedWebhooks, WholesaleFeedWebhookRegistrationError } from './register';
export type {
  RegisterWholesaleFeedWebhooksOptions,
  WholesaleFeedWebhookEventType,
  WholesaleFeedWebhookRegistrationClient,
  WholesaleFeedWebhookSubscriber,
} from './register';
export {
  normalizeWholesaleFeedWebhookNotification,
  parseWholesaleFeedWebhookNotification,
  WholesaleFeedWebhookNotificationError,
} from './webhook-notification';
export type {
  WholesaleFeedSyncClient,
  WholesaleFeedSyncConfig,
  WholesaleFeedSyncEvents,
  WholesaleFeedSyncMode,
  WholesaleFeedSyncPersistedState,
  WholesaleFeedSyncPersistenceHooks,
  WholesaleFeedSyncState,
  ProductFilter,
  ResolvedCapabilities,
  SignalFilter,
} from './types';
export type {
  NormalizedWholesaleFeedWebhookNotification,
  WholesaleFeedWebhookAffectedEntityType,
  WholesaleFeedWebhookCacheScope,
  WholesaleFeedWebhookNotificationErrorCode,
  WholesaleFeedWebhookNotificationErrorDetails,
  WholesaleFeedWebhookNotificationType,
} from './webhook-notification';
export type {
  LegacyWholesaleFeedEvent,
  LegacyWholesaleFeedWebhook,
  LegacyWholesaleProduct,
  LegacyWholesaleSignal,
} from './protocol-types';
