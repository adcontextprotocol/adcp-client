/** Opinionated PostgreSQL webhook runtime: storage, outbox, recovery and SQL. */

import type { PgQueryable } from '../postgres-task-store';
import type { WebhooksConfig } from '../create-adcp-server';
import {
  createWebhookEmitter,
  type RecoverableWebhookEmitter,
  type WebhookEmitResult,
  type WebhookEmitterOptions,
} from '../webhook-emitter';
import {
  getWebhookDeliveryMigration,
  getWebhookDeliveryRecoveryMigration,
  pgWebhookDeliveryRecoveryBackend,
  pgWebhookDeliveryStore,
  type PgWebhookDeliveryRecoveryOptions,
  type PgWebhookDeliveryStoreOptions,
} from './pg';
import {
  createWebhookDeliveryRecovery,
  pollWebhookDeliveryRecovery,
  type CreateWebhookDeliveryRecoveryOptions,
  type PollWebhookDeliveryRecoveryOptions,
  type WebhookAuthenticationAdapter,
} from './recovery';

export interface CreatePostgresWebhookRuntimeOptions extends Omit<
  WebhookEmitterOptions,
  'deliveryStore' | 'idempotencyKeyStore' | 'deliveryRecovery'
> {
  db: PgQueryable;
  /** Stable publisher namespace used to fence every recovery claim. */
  publisherScope: string;
  /** Durable delivery-identity table configuration. */
  deliveries?: PgWebhookDeliveryStoreOptions;
  /** Durable retry outbox configuration. */
  outbox?: Omit<PgWebhookDeliveryRecoveryOptions, 'claimScope'>;
  /** Protect bearer/HMAC material before it enters the outbox. */
  authenticationAdapter?: WebhookAuthenticationAdapter;
  /** Lease and snapshot limits for recovery. */
  recovery?: Omit<CreateWebhookDeliveryRecoveryOptions, 'backend' | 'authenticationAdapter' | 'protectPayloadToken'>;
  /** Default delay used when a recovered send exhausts retryable attempts. */
  recoveryRetryAfterMs?: number;
}

export type PostgresWebhookRecoveryPollOptions = Omit<PollWebhookDeliveryRecoveryOptions, 'recovery' | 'deliver'>;

export interface PostgresWebhookRuntime {
  emitter: RecoverableWebhookEmitter;
  /** Ready-to-pass `webhooks` option for `createAdcpServerFromPlatform()`. */
  serverConfig: WebhooksConfig;
  /** SQL to run with the application's migration system before `probe()`. */
  migrations: {
    deliveries: string;
    outbox: string;
    all: readonly [string, string];
  };
  /** Fail fast when either required table is absent or incompatible. */
  probe(): Promise<void>;
  /** Run one bounded, fenced recovery pass with result mapping handled by the SDK. */
  recoverOnce(options?: PostgresWebhookRecoveryPollOptions): Promise<{
    claimed: number;
    settled: number;
    released: number;
  }>;
}

export type WebhookRecoveryDisposition =
  | { disposition: 'delivered' }
  | { disposition: 'terminal' }
  | { disposition: 'retry'; retryAfterMs: number };

/** Normalize emitter flags into the recovery poller's exhaustive result. */
export function toWebhookRecoveryDisposition(
  result: Readonly<WebhookEmitResult>,
  retryAfterMs: number
): WebhookRecoveryDisposition {
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 604_800_000) {
    throw new TypeError('retryAfterMs must be an integer from 1 through 604800000');
  }
  if (result.delivered) return { disposition: 'delivered' };
  if (result.terminal === true) return { disposition: 'terminal' };
  return { disposition: 'retry', retryAfterMs };
}

/**
 * Construct the complete production PostgreSQL webhook workflow.
 *
 * This replaces the error-prone manual assembly of a delivery store, recovery
 * backend, emitter, poller disposition mapping, probes and migrations.
 */
export function createPostgresWebhookRuntime(options: CreatePostgresWebhookRuntimeOptions): PostgresWebhookRuntime {
  const retryAfterMs = options.recoveryRetryAfterMs ?? 30_000;
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 604_800_000) {
    throw new TypeError('recoveryRetryAfterMs must be an integer from 1 through 604800000');
  }

  const deliveryStore = pgWebhookDeliveryStore(options.db, options.deliveries);
  const claimScope = {
    publisherScope: options.publisherScope,
    ...(options.tenantScope === undefined ? {} : { tenantScope: options.tenantScope }),
  };
  const recovery = createWebhookDeliveryRecovery({
    ...options.recovery,
    backend: pgWebhookDeliveryRecoveryBackend(options.db, { ...options.outbox, claimScope }),
    authenticationAdapter: options.authenticationAdapter,
    protectPayloadToken: true,
  });
  const {
    db: _db,
    deliveries: _deliveries,
    outbox: _outbox,
    authenticationAdapter: _authenticationAdapter,
    recovery: _recovery,
    recoveryRetryAfterMs: _recoveryRetryAfterMs,
    ...emitterOptions
  } = options;
  const emitter = createWebhookEmitter({
    ...emitterOptions,
    deliveryStore,
    deliveryRecovery: recovery,
  });
  const serverConfig: WebhooksConfig = {
    ...emitterOptions,
    publisherScope: options.publisherScope,
    ...(options.tenantScope === undefined ? {} : { tenantScope: options.tenantScope }),
    deliveryStore,
    deliveryRecovery: recovery,
  };
  const deliveriesMigration = getWebhookDeliveryMigration(options.deliveries);
  const outboxMigration = getWebhookDeliveryRecoveryMigration(options.outbox);

  return {
    emitter,
    serverConfig,
    migrations: {
      deliveries: deliveriesMigration,
      outbox: outboxMigration,
      all: [deliveriesMigration, outboxMigration],
    },
    async probe(): Promise<void> {
      await deliveryStore.probe();
      await recovery.probe();
    },
    recoverOnce(pollOptions = {}) {
      return pollWebhookDeliveryRecovery({
        ...pollOptions,
        recovery,
        async deliver(lease) {
          const result = await emitter.forTenantScope(lease.key.tenantScope).emitRecovered(lease);
          return toWebhookRecoveryDisposition(result, retryAfterMs);
        },
      });
    },
  };
}
