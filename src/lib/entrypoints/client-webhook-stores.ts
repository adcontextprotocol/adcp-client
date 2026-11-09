// `@adcp/sdk/client/webhook-stores`: durable webhook-registration stores for
// multi-replica buyers (PostgreSQL and Redis), without loading the package root.
//
// These stay off `@adcp/sdk/client/core` on purpose: most clients use the
// in-memory store exported there, and the durable stores are an opt-in
// deployment choice. Neither store imports a database driver; each takes the
// caller's client.
//
// Every name here is exported by `@adcp/sdk` under the same name, from the same
// source module. Add a name here only when the root exports it under the same
// name (`test/lib/runtime-subpaths.test.js` enforces this).

export {
  pgWebhookRegistrationStore,
  getWebhookRegistrationMigration,
  WEBHOOK_REGISTRATION_MIGRATION,
  cleanupExpiredWebhookRegistrations,
  type PgWebhookRegistrationStoreOptions,
  type CleanupExpiredWebhookRegistrationsOptions,
} from '../core/postgres-webhook-registration-store';
export {
  redisWebhookRegistrationStore,
  type RedisWebhookRegistrationStoreOptions,
} from '../core/redis-webhook-registration-store';
