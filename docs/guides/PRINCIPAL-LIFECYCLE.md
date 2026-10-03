# Principal lifecycle

AdCP resolves a principal from authenticated transport state. A buyer never sends
its own `principal_id`; it reads the seller-issued configuration version and uses
that opaque value only as an optimistic-concurrency fence.

Use the typed methods for individual operations:

```ts
const current = await seller.getPrincipal();

await seller.syncPrincipal({
  idempotency_key: crypto.randomUUID(),
  expected_configuration_version:
    current.status === 'completed' && current.data.result.kind === 'current'
      ? current.data.result.configuration_version
      : undefined,
  configuration: {
    notification_configs: [],
  },
});
```

For normal setup, `syncPrincipalLifecycle` performs the bounded read, guarded
replacement, conflict retry, and destination-state polling as one operation:

```ts
import { syncPrincipalLifecycle } from '@adcp/sdk';

const controller = new AbortController();
const result = await syncPrincipalLifecycle(
  seller,
  {
    reporting_destinations: [destination],
    declarations: {
      async_adcp_versions: ['3.2'],
      webhook_signing_algorithms: ['ed25519'],
    },
  },
  {
    maxAttempts: 3,
    setupTimeoutMs: 60_000,
    pollIntervalMs: 1_000,
    signal: controller.signal,
  }
);

if (!result.destinationsReady) {
  // At least one active destination is still pending or reached action_required/rejected.
  console.log(result.current.configuration.reporting_destinations);
}

console.log(result.declarations?.accepted);
console.log(result.declarations?.selected_async_adcp_version);
console.log(result.declarations?.exclusions);
```

Each conflict retry is a new logical mutation with a fresh idempotency key and
the latest `configuration_version`. After a lost response, the caller owns replay:
catch `PrincipalLifecycleError` and resend its non-enumerable `attemptedRequest`
unchanged. That field preserves the helper-generated idempotency key and fences
without leaking them through ordinary error serialization. Polling stops when
every active destination submitted by this call is ready, when any such destination
reaches a terminal setup state, when the timeout expires, or when the caller aborts. It
also fails closed if the authenticated principal or configuration version changes
while setup is being observed; seller-driven setup transitions keep the same
version by protocol contract. Caller-suspended (`active: false`) destinations
are excluded from the readiness quorum.

If a protocol task is accepted asynchronously or pauses for input/authentication,
the helper throws `PrincipalLifecycleError` with the original `taskResult`
attached. Use its `submitted` or `deferred` continuation when present; do not
start a second logical replacement with a new idempotency key.

## Seller runtime

`createPrincipalLifecycle()` is the server-side owner for `get_principal`,
`sync_principal`, with an opt-in specialized `sync_agent_notification_configs`
compatibility task. It keeps all caller-owned sections, the internal
notification generation, reporting-destination generations, and pending
`principal.changed` events in one CAS record.

```ts
import {
  PostgresStateStore,
  createAdcpServerFromPlatform,
  createPostgresWebhookRuntime,
  createPersistentNotificationRuntime,
  createPrincipalLifecycle,
  createPrincipalStateStore,
  principalNotificationSubscriptionStore,
} from '@adcp/sdk/server';

const state = new PostgresStateStore(pool);
const principalStore = createPrincipalStateStore({
  store: state,
  durability: 'durable',
});

let principalWebhooks: ReturnType<typeof createPostgresWebhookRuntime>;
const notifications = createPersistentNotificationRuntime({
  store: principalNotificationSubscriptionStore(principalStore),
  proofAdapter,
  credentialAdapter,
  authorizeDelivery,
  // Persist a pre-POST attempt fence in the same operational checkpoint
  // system used by the principal event worker.
  checkpointDeliveryAttempt: principalAttemptCheckpoint,
  createEmitter(authorizeAttempt) {
    principalWebhooks = createPostgresWebhookRuntime({
      db: pool,
      publisherScope: 'seller-principal-events',
      deliveries: { tableName: 'seller_principal_webhook_deliveries' },
      outbox: { tableName: 'seller_principal_webhook_outbox' },
      signerProvider,
      authenticationAdapter,
      authorizeAttempt,
    });
    return principalWebhooks.emitter;
  },
});

const principals = createPrincipalLifecycle({
  store: principalStore,
  notifications,
  agentUrl: 'https://seller.example/mcp',
  // Only authenticated server context is available here. Use a stable auth
  // subject; never a request field, account reference, or session-local token.
  resolvePrincipal: ctx => ({
    tenant_id: trustedTenant(ctx.authInfo),
    principal_id: stableAuthenticatedSubject(ctx.authInfo),
    principal_kind: trustedPrincipalKind(ctx.authInfo),
  }),
  declarations: sellerDeclarationSupport,
  prepareReportingDestination: validateAndCanonicalizeDestination,
});

const server = createAdcpServerFromPlatform(platform, {
  name: 'seller-production',
  version: '1.0.0',
  protocol: principals.protocol,
});
```

Principal handlers require `protocol.resolvePrincipalScope`; the lifecycle
supplies it. The framework invokes it before authentication-sensitive reads and
before idempotency lookup, so do not replace it with a resolver derived from
request fields.

Existing raw principal handlers must migrate any principal resolver previously
passed as `protocol.resolveScope` to `protocol.resolvePrincipalScope`.
`resolveScope` keeps its notification-only request type and remains required
when `syncAgentNotificationConfigs` is registered.

`sync_agent_notification_configs` is omitted by default so platform-built
servers do not advertise an unsupported capability-change surface. Set
`includeCompatibilityNotificationTask: true` only when the server also
advertises `capability_changes.notifications` and routes both tasks through
this same lifecycle.

Run the state-store migration and the dedicated webhook delivery/outbox
migrations before startup. Schedule both webhook recovery and principal-event
recovery; one principal pass is deliberately bounded:

```ts
let cursor: string | undefined;
do {
  const pass = await principals.recoverPrincipalNotifications({ limit: 100, cursor });
  cursor = pass.nextCursor;
} while (cursor);
```

### Operational methods

- `recognizePrincipal()` durably records an already issued principal identity
  without inventing configuration; this is the explicit path to a `recognized`
  read when the auth resolver does not return `principal_record_id`.
- `transitionDestination()` records seller-observed setup state after external
  proof. `deferNotification` leaves the committed invalidation for a worker.
- `reconcileDeclarations()` reapplies current seller support to stored caller
  declarations and queues the required invalidation.
- `flushPrincipalNotifications()` processes one bounded principal outbox;
  `recoverPrincipalNotifications()` scans bounded pages and reports the number
  of scopes whose flush failed.

### Persistence and transaction contract

- `PrincipalStateStore.replace()` must be a linearizable compare-and-swap over
  the complete record. Custom stores must preserve the trusted
  `(tenantId, principalId)` scope, return opaque revisions, enumerate pending
  notification scopes, and report `durability: 'durable'` only when records
  survive process loss. Production rejects process-local stores.
- Use exactly one notification writer. The notification runtime must use
  `principalNotificationSubscriptionStore(principalStore)`; do not pair the
  principal lifecycle with a second subscription table or the standalone
  compatibility handler.
- Framework idempotency resolves an exact replay before the lifecycle handler.
  Keep durable idempotency enabled in production. A changed payload under the
  same key remains an error; concurrent updates additionally race on the shared
  `configuration_version` and the store CAS.
- A caller sync advances `configuration_version` only after every submitted
  section is prepared and the complete record commits. Seller-driven
  destination transitions and declaration-intersection changes keep that
  version stable, commit state plus the event outbox entry first, and emit only
  afterward.
- `prepareReportingDestination` is validation/canonicalization only. It must
  not create a provider grant and cannot return `ready`. After external proof,
  call `transitionDestination()` with the current `destination_ref`. Rejected,
  expired, suspended, removed, and reintroduced destinations retain their old
  generations for audit while authorization uses a fresh reference. Resolve a
  job's pinned reference with `resolveReportingDestination()` and require
  `deliveryEligible` before delivery.
- Notification credential staging follows the crash contract in
  [persistent notification subscriptions](./PERSISTENT-NOTIFICATION-RUNTIME.md):
  stages are independently idempotent, CAS makes a binding live, and reapers
  check the principal record before deleting an apparently abandoned stage.
- The lifecycle requires a delivery-attempt checkpoint so a crash after POST
  does not silently turn into an untracked duplicate. The
  `acknowledgeMissingAttemptCheckpoint` escape hatch is for deployments that
  explicitly accept that at-least-once ambiguity, not the production default.
- Principal event flushing, recovery, pending invalidations, and retained
  reporting generations are bounded. The default caps are 100 events per
  flush, 256 pending invalidations, and 256 reporting generations. Pending
  `principal.changed` invalidations coalesce by dropping the oldest
  non-critical entry when the cap is reached. The deactivation invalidation
  that a subscriber is temporarily pinned to is never evicted. Current and
  superseded reporting generations are never pruned automatically because
  retained account bindings may still reference them; rotation backpressures
  at the configured or protocol readback bound. Explicit revocation makes all
  affected generations ineligible and applies the protocol's bounded retired
  history window, allowing a full section clear to complete.
- Account authorization is independent of principal identity. A principal
  record never grants access to an account or reporting data by itself.
  Account-owned subscriber sets need their own notification runtime/store;
  the principal-backed runtime accepts caller scope only. “One writer” applies
  to each owned subscriber set, not to every notification scope globally.
