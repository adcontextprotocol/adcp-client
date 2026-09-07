# Persistent notification subscriptions

Use the persistent notification runtime for standing caller- or account-level
subscriptions. It composes subscription state with the SDK webhook delivery
kernel; it does not replace task `push_notification_config` registration.

The runtime owns:

- caller and caller+account isolation;
- atomic full-set replacement with generation CAS;
- exact destination-tuple proof state;
- write-only legacy credential bindings;
- anchor-safe event matching and fanout; and
- live authorization before every external attempt and retry.

Your application still decides when a domain event exists and whether the
subscriber remains authorized for its account at delivery time.

## PostgreSQL setup

Use one pool for subscription state, delivery identity, and the recovery
outbox:

```ts
import {
  createPersistentNotificationProtocolHandlers,
  createPostgresPersistentNotificationRuntime,
} from '@adcp/sdk/server';

const notifications = createPostgresPersistentNotificationRuntime({
  db: pool,
  publisherScope: 'seller-production',
  subscriptions: { tableName: 'seller_notification_subscriptions' },
  webhooks: {
    deliveries: { tableName: 'seller_webhook_deliveries' },
    outbox: { tableName: 'seller_webhook_outbox' },
    signerProvider,
  },
  proofAdapter: {
    async prove(candidate) {
      // POST the AdCP proof challenge using a pin-and-bind client. Bind the
      // proof to candidate.destinationGeneration and return no credentials.
      return endpointProof(candidate);
    },
  },
  credentialAdapter: {
    async preview({ credential, previousBindingId, signal, ...context }) {
      // Compare inside the secret manager. Do not hash or persist the secret.
      return (await vault.matches(previousBindingId, credential, { ...context, signal }))
        ? { outcome: 'unchanged' }
        : { outcome: 'changed' };
    },
    async stage({ credential, previousBindingId, signal, ...context }) {
      // Never rotate previousBindingId in place. Stage changed material under
      // a fresh random opaque binding and return an idempotent stage token.
      return vault.stageVersion(credential, { ...context, previousBindingId, signal });
    },
    async commit(stage) {
      await vault.commitStage(stage);
    },
    async discard(stage) {
      await vault.discardStage(stage);
    },
    async resolve(binding) {
      return vault.resolveForWebhookAttempt(binding);
    },
  },
  async authorizeDelivery({ scope, eventAnchor, accountId, subscriberId }) {
    // This runs immediately before every POST, including recovered retries.
    return grants.mayReceive({ scope, eventAnchor, accountId, subscriberId });
  },
  // Optional. Only list later-version caller events whose payload is
  // invalidation-only; this is the allowlist behind include_future_event_types.
  futureCallerInvalidationEventTypes: ['catalog.invalidated'],
  adopterCallbackTimeoutMs: 30_000,
  fanoutConcurrency: 8,
  onCredentialStageError: event => monitorCredentialVault(event),
});

for (const sql of notifications.migrations.all) await pool.query(sql);
await notifications.probe();
```

The default registration validator resolves DNS and applies the strict webhook
SSRF policy even for inactive entries. Delivery independently re-resolves and
pins the connection on every attempt.

Legacy binding IDs are random opaque credential-version handles, never secret
hashes. `stage()` must keep a new version durable and resolvable for endpoint
proof and delivery without changing the old binding. The runtime calls
`commit()` only after subscription CAS succeeds and calls `discard()` after
validation, proof, or CAS failure. All three operations must be idempotent.
`commit()` is bookkeeping: the successful CAS makes the staged binding live,
so a commit timeout or failure cannot roll back the replacement. Reapers for
stages abandoned by a process crash must check the durable subscription store
before deleting them. Retire a superseded binding only after no generation
references it and after a bounded grace period for already-authorized in-flight
deliveries. Never share one staged binding between concurrent staging
operations, even if they happen to carry the same credential; a losing CAS may
discard only its own stage. Use `onCredentialStageError` for non-blocking
visibility into failed commit/discard bookkeeping; the observer cannot change
the replacement result.

Every adopter callback receives an `AbortSignal` and is bounded by
`adopterCallbackTimeoutMs`. Honor the signal so a timed-out staging operation
cannot complete late. Configure the subscription store's database/query
deadline transactionally; the runtime deliberately does not race a mutating
CAS against a timer because that could commit after its credential stage was
discarded. Fanout runs at most `fanoutConcurrency` independent
subscriber retry cycles simultaneously and preserves result ordering. An
exception in one subscriber's delivery kernel is isolated as
`failure.reason === 'delivery_runtime_error'`; it does not detach or hide the
other subscribers' results.

`include_future_event_types` is fail closed. It has no effect unless the server
classifies a later-version caller event in
`futureCallerInvalidationEventTypes`; account-anchored or payload-bearing event
types must never be placed in that allowlist.

## Specialized caller-level compatibility task

The supplied protocol handler is a compatibility-only owner for
`sync_agent_notification_configs`:

```ts
const protocol = createPersistentNotificationProtocolHandlers(
  notifications,
  async ctx => ({
    tenant_id: trustedTenantFrom(ctx),
    principal_id: trustedPrincipalFrom(ctx),
  }),
);

const server = createAdcpServerFromPlatform(platform, {
  name: 'seller-production',
  version: '1.0.0',
  protocol,
});
```

Do not also configure a separate `syncAgentNotificationConfigs` writer. The
helper is the handler and applies declarative replacement only inside the
authenticated caller scope.

The notification runtime's webhook kernel is private to standing
subscriptions. Do not reuse it as the server-wide `webhooks` configuration:
ordinary task callbacks do not carry subscription authorization context. If
the server also emits task or media-buy callbacks, configure their webhook
runtime separately, with a distinct outbox namespace or table set.

This helper cannot atomically update the broader `sync_principal` document or
advance its shared `configuration_version`. When both surfaces coexist, AdCP
requires the application-owned `sync_principal` transaction to update all
principal sections and the shared version together. That transaction should
call `notifications.replace()` for the caller scope and use the returned
generation as the notification-section version; do not compose the
compatibility handler into that transaction.
Likewise, an account `sync_accounts` handler calls `replace()` with:

```ts
const scope = {
  kind: 'account' as const,
  tenantId: trustedTenant,
  principalId: authenticatedPrincipal,
  accountId: resolvedSellerAccountId,
};
const applied = await notifications.replace(scope, request.notification_configs ?? []);
```

Project `notificationConfigs` into `get_principal` or `list_accounts` with
`projectNotificationSubscriptionReadback()`. It removes the SDK-only
`destination_generation` and `proof_generation` fields. Those fields remain
available as safe operational readback for the owning application; legacy
authentication credentials are never returned.

## Fire an event

```ts
await notifications.emit({
  emissionId: durableOutboxEvent.id,
  notificationId: change.change_id,
  notificationType: 'account.change_recorded',
  anchor: 'account',
  tenantId: trustedTenant,
  accountId: change.account_id,
  payload: {
    change_id: change.change_id,
    fired_at: new Date().toISOString(),
    recorded_at: change.recorded_at,
    resource: {
      type: change.resource_type,
      resource_id: change.resource_id,
    },
    action: change.action,
    through_cursor: change.through_cursor,
  },
});
```

Persist `emissionId` with the domain event. Reuse it after an ambiguous crash;
rotate it only when intentionally re-emitting the same logical
`notificationId` as a new delivery event. Each matched subscriber receives an
independent transport `idempotency_key` while the logical `notification_id`
stays stable.

Run bounded recovery passes from a scheduler:

```ts
await notifications.recoverOnce({ ownerToken: stableWorkerId });
```

Removal, pause, destination replacement, or authorization loss terminally
suppresses unclaimed old work. A POST already authorized and in flight cannot
be retracted; delivery remains at least once.
