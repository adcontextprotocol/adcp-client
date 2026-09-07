import type { PgQueryable } from '../postgres-task-store';
import {
  createPostgresWebhookRuntime,
  type CreatePostgresWebhookRuntimeOptions,
  type PostgresWebhookRecoveryPollOptions,
  type PostgresWebhookRuntime,
} from '../webhook-delivery/postgres-runtime';
import { createPersistentNotificationRuntime } from './runtime';
import {
  getNotificationSubscriptionMigration,
  pgNotificationSubscriptionStore,
  type PostgresNotificationSubscriptionStoreOptions,
} from './postgres-store';
import type {
  NotificationCredentialBindingAdapter,
  NotificationDestinationValidator,
  NotificationDeliveryAuthorizer,
  NotificationProofAdapter,
  PersistentNotificationRuntime,
  PersistentNotificationRuntimeOptions,
} from './types';

export interface CreatePostgresPersistentNotificationRuntimeOptions {
  db: PgQueryable;
  publisherScope: string;
  subscriptions?: PostgresNotificationSubscriptionStoreOptions;
  webhooks: Omit<CreatePostgresWebhookRuntimeOptions, 'db' | 'publisherScope' | 'authorizeAttempt'>;
  proofAdapter: NotificationProofAdapter;
  credentialAdapter?: NotificationCredentialBindingAdapter;
  authorizeDelivery: NotificationDeliveryAuthorizer;
  validateDestination?: NotificationDestinationValidator;
  supportedCallerEventTypes?: readonly string[];
  supportedAccountEventTypes?: readonly string[];
  futureCallerInvalidationEventTypes?: readonly string[];
  maxFanoutCandidates?: number;
  fanoutConcurrency?: number;
  adopterCallbackTimeoutMs?: number;
  onCredentialStageError?: PersistentNotificationRuntimeOptions['onCredentialStageError'];
}

export interface PostgresPersistentNotificationRuntime extends PersistentNotificationRuntime {
  /**
   * Delivery/recovery kernel dedicated to standing subscriptions. It
   * deliberately omits `serverConfig`: its mandatory subscription authorizer
   * must never become the server-wide task-webhook authorizer.
   */
  webhooks: Omit<PostgresWebhookRuntime, 'serverConfig'>;
  migrations: {
    subscriptions: string;
    webhookDeliveries: string;
    webhookOutbox: string;
    all: readonly string[];
  };
  probe(): Promise<void>;
  recoverOnce(options?: PostgresWebhookRecoveryPollOptions): ReturnType<PostgresWebhookRuntime['recoverOnce']>;
}

/**
 * Opinionated PostgreSQL assembly: durable subscription CAS state plus the
 * existing durable webhook delivery/recovery kernel, sharing one pool.
 */
export function createPostgresPersistentNotificationRuntime(
  options: CreatePostgresPersistentNotificationRuntimeOptions
): PostgresPersistentNotificationRuntime {
  if (!options?.db) throw new TypeError('createPostgresPersistentNotificationRuntime requires db');
  const store = pgNotificationSubscriptionStore(options.db, options.subscriptions);
  let webhooks: PostgresWebhookRuntime | undefined;
  const runtime = createPersistentNotificationRuntime({
    store,
    proofAdapter: options.proofAdapter,
    ...(options.credentialAdapter === undefined ? {} : { credentialAdapter: options.credentialAdapter }),
    authorizeDelivery: options.authorizeDelivery,
    ...(options.validateDestination === undefined ? {} : { validateDestination: options.validateDestination }),
    ...(options.supportedCallerEventTypes === undefined
      ? {}
      : { supportedCallerEventTypes: options.supportedCallerEventTypes }),
    ...(options.supportedAccountEventTypes === undefined
      ? {}
      : { supportedAccountEventTypes: options.supportedAccountEventTypes }),
    ...(options.futureCallerInvalidationEventTypes === undefined
      ? {}
      : { futureCallerInvalidationEventTypes: options.futureCallerInvalidationEventTypes }),
    ...(options.maxFanoutCandidates === undefined ? {} : { maxFanoutCandidates: options.maxFanoutCandidates }),
    ...(options.fanoutConcurrency === undefined ? {} : { fanoutConcurrency: options.fanoutConcurrency }),
    ...(options.adopterCallbackTimeoutMs === undefined
      ? {}
      : { adopterCallbackTimeoutMs: options.adopterCallbackTimeoutMs }),
    ...(options.onCredentialStageError === undefined ? {} : { onCredentialStageError: options.onCredentialStageError }),
    createEmitter(authorizeAttempt) {
      webhooks = createPostgresWebhookRuntime({
        ...options.webhooks,
        db: options.db,
        publisherScope: options.publisherScope,
        authorizeAttempt,
      });
      return webhooks.emitter;
    },
  });
  if (!webhooks) throw new Error('Persistent notification webhook runtime was not initialized');
  const initializedWebhooks = webhooks as PostgresWebhookRuntime;
  const notificationWebhooks: Omit<PostgresWebhookRuntime, 'serverConfig'> = {
    emitter: initializedWebhooks.emitter,
    migrations: initializedWebhooks.migrations,
    probe: () => initializedWebhooks.probe(),
    recoverOnce: recoverOptions => initializedWebhooks.recoverOnce(recoverOptions),
  };
  const subscriptionsMigration = getNotificationSubscriptionMigration(options.subscriptions);
  return {
    ...runtime,
    webhooks: notificationWebhooks,
    migrations: {
      subscriptions: subscriptionsMigration,
      webhookDeliveries: initializedWebhooks.migrations.deliveries,
      webhookOutbox: initializedWebhooks.migrations.outbox,
      all: [subscriptionsMigration, ...initializedWebhooks.migrations.all],
    },
    async probe() {
      await store.probe?.();
      await initializedWebhooks.probe();
    },
    recoverOnce(recoverOptions) {
      return initializedWebhooks.recoverOnce(recoverOptions);
    },
  };
}
