# Migrating from 13.x to the 14 prerelease

SDK 14 adopts AdCP `3.2.0-beta.10` while preserving the canonical creative boundary introduced in SDK 13. Most SDK 13 applications can install the prerelease and continue using the established 3.x tools unchanged; adopt the compact 3.2 lifecycle only after the remote agent advertises it.

Legacy signal-discovery adapters may keep supplying `opts.signals.getSignals`
(or `legacyHandlers.signals.getSignals`) while declaring the truthful
`signal-marketplace` or `signal-owned` specialism. That compatibility handler
now satisfies platform validation without requiring adopters to invent an
`activate_signal` implementation during an incremental migration.

AdCP 3.2 prereleases are exact protocol pins: beta.6 replaces beta.5 in the
SDK's compatible-version list rather than extending a rolling 3.2-beta range.
Beta.1 restored `adcp_major_version` on `buy_products`,
`accept_proposal`, and `control_media_buy`; the SDK now sends that field again
for beta.1 and later while retaining its omission only for an explicitly
configured beta.0 peer. Beta.2 added canonical compact proposal and direct-buy
storyboards through operational control and MediaBuy readback; beta.4 adds
flexible-window availability and durable products-only legacy purchase
continuations. Beta.5 defines stable async identity, cross-channel terminal
convergence, webhook retry horizons, and crash-safe continuation generation
replacement. Beta.6 adds coordinated placements, seller-rendered stateful
display, creative component assets, and A2A 1.0 request-signing method names.

### A2A 1.0 peer upgrade

SDK 14's AdCP 3.2 transport requires `@a2a-js/sdk` 1.x. Upgrade the peer
alongside the AdCP SDK:

```bash
npm install '@adcp/sdk@^14.0.0-0' @a2a-js/sdk@^1.0.1
```

The client and server use the official 1.0 Agent Card and JSON-RPC APIs and
activate the required `https://adcontextprotocol.org/extensions/adcp/v3`
profile. Wire interoperability with 0.3 agents remains available through the
1.x SDK's compatibility layer; applications should not keep the 0.3 package
installed. Existing `createA2AAdapter()` card options remain accepted, but
`preferredTransport` and `protocolVersion` are deprecated because the adapter
now advertises JSON-RPC 1.0 plus its 0.3 compatibility interface.

### Cross-origin signing-key delegation

Signing-key discovery now evaluates the complete matching
`authorized_operators[]` entry. Bare strings, missing/empty `brands`, malformed
validity timestamps, future grants, and grants at or after `valid_until` no
longer authorize an operator. Domain comparison remains eTLD+1-based (including
private suffixes), while brand, activity scope, country, and time must all match
the same entry.

Broad grants remain configuration-free: use `brands: ['*']`, omit `scopes` for
all activities (or use `['all']`), and omit `countries` for global scope. If a
house publishes a constrained grant, bind the trusted verification context:

```ts
const client = new SingleAgentClient(agent, {
  webhookVerification: {
    resolverOptions: {
      requiredOperatorBrand: 'brand_a',
      requiredOperatorScope: 'media_buying',
      requiredOperatorCountry: 'GB',
    },
  },
});
```

These resolver options remain a trusted client-wide fallback for a client that
uses one tuple. Shared clients can now select and durably persist the trusted
tuple per dispatch:

```ts
await client.createMediaBuy(request, undefined, {
  delegatedOperatorAuthorization: {
    brand: 'brand_b',
    scope: 'media_buying',
    country: 'US',
  },
});
```

The per-call object takes whole-object precedence and is local receiver policy;
the SDK neither infers it from request fields nor sends it on the wire. Custom
`WebhookRegistrationStore` implementations must round-trip the versioned
authorization fields so restart-time verification can revalidate the tuple
against live `brand.json`, with immediate read-your-writes consistency after
`putIfAbsent()`. The SDK reads the row back before seller dispatch and fails
closed if a legacy projection drops either field. Do not persist a prior allow
decision as authority.

Pre-upgrade RFC 9421 rows without `authorizationContextVersion` cannot be
safely backfilled from the receiver's current configuration. Automatic key
discovery rejects them after upgrade; drain them first or re-dispatch the
operation to create a versioned registration. A caller-supplied
`webhookVerification.jwks` may support legacy rows only when it independently
preserves their original trust boundary.

### Durable webhook registration across replicas

The process-local registration store cannot survive a restart or route a
callback to another replica. SDK 14 includes first-party PostgreSQL and Redis
stores with the same atomic create-or-identical contract:

```ts
import {
  SingleAgentClient,
  cleanupExpiredWebhookRegistrations,
  getWebhookRegistrationMigration,
  pgWebhookRegistrationStore,
  redisWebhookRegistrationStore,
} from '@adcp/sdk';
import { PostgresReplayStore, getReplayStoreMigration } from '@adcp/sdk/signing/server';

// PostgreSQL deployment bootstrap:
await pool.query(getWebhookRegistrationMigration({
  tableName: 'buyer_eu_webhook_registrations',
}));
const registrations = pgWebhookRegistrationStore(pool, {
  tableName: 'buyer_eu_webhook_registrations',
});
await registrations.probe();
await pool.query(getReplayStoreMigration('buyer_eu_webhook_replays'));
const sharedReplayStore = new PostgresReplayStore(pool, {
  tableName: 'buyer_eu_webhook_replays',
});

// Or Redis, using the same deployment-unique prefix on every replica:
const redisRegistrations = redisWebhookRegistrationStore(redis, {
  keyPrefix: 'buyer-eu:webhook-registration:v1:',
});
await redisRegistrations.probe();

// Construct this identically in outbound workers and inbound HTTP replicas.
const client = new SingleAgentClient(agentWithStableId, {
  webhookRegistrationStore: registrations, // or redisRegistrations
  webhookVerification: { replayStore: sharedReplayStore },
});

// Schedule for PostgreSQL; expiry checks do not depend on this cleanup.
await cleanupExpiredWebhookRegistrations(pool, {
  tableName: 'buyer_eu_webhook_registrations',
  batchSize: 1_000,
});
```

Run migrations and `probe()` before serving traffic. All replicas must use the
same stable agent id and the same isolated table or key prefix. Redis reads
must be primary-consistent and the deployment must support Lua. Retain records
for at least the seller retry horizon; monitor Redis capacity because eviction
causes fail-closed callback unavailability. RFC 9421 additionally requires a
shared durable replay store so two replicas cannot accept the same signature.

Existing custom-store rows are not imported automatically. They must preserve
the complete `authorizationContextVersion` and
`delegatedOperatorAuthorization` tuple. Drain or re-dispatch legacy/lossy rows
rather than deriving their original authority from current configuration.

The same options are accepted by `resolveAgent()`, `getAgentJwks()`,
`createAgentJwksSet()`, and `ResolvedAgentJwksResolver`. A constrained list with
no corresponding trusted option fails closed. Built-in JWKS caches now expire
at the earlier of their configured TTL and the accepted delegation's
`valid_until` boundary. Low-level `getAgentJwks()` callers receive that boundary
as `operatorAuthorizationValidUntil` and must apply it to any custom cache.
Webhook verification also rechecks that boundary immediately before accepting a
delivery and committing its replay nonce.

### Modern MCP validation errors

Modern MCP `tools/list` continues to advertise the exact official AdCP input
schema. Call-time domain validation now remains in the AdCP framework pipeline,
so schema-invalid AdCP objects return the framework's structured `adcp_error`
and `context` echo instead of a generic MCP input-validation string. Because
the modern transport advertises that strict schema, it requests strict
framework request validation even when the server-wide validation mode is
`warn` or `off`; explicit custom tool schemas remain enforced by the MCP server
layer.

### Beta.5 task webhook registration and polling

`push_notification_config` is now an AdCP application-layer field across MCP,
A2A, and REST. On A2A it is carried in skill parameters and remains distinct
from native `TaskPushNotificationConfig`. Every beta.5-or-later registration must carry
a buyer `operation_id`; SDK clients generate and reuse one identity across the
authorized request, registration provenance, route, and webhook envelope.
Beta.5-or-later sellers return `INVALID_REQUEST` before handler dispatch when the field
is missing or malformed. Explicitly negotiated older bundles keep their prior
wire behavior.

Receivers continue to fence exact delivery retries by seller plus
`idempotency_key`, and additionally fence terminal publication by authenticated
seller, buyer `operation_id`, and seller `task_id`. This prevents a beta.5
terminal re-emission under a new delivery key from running handlers twice while
keeping seller task IDs that are scoped per buyer operation isolated. Configure
shared durable `webhookDedup` storage for multi-replica receivers.

When polling with `include_result: true`, `get_task_status`/`tasks_get` now
returns a stored canonical artifact for `completed`, `failed`, and `rejected`
tasks. A failed response may carry both the top-level summary `error` and a
canonical `result.errors[]`; they describe the same failure.

```bash
npm install '@adcp/sdk@^14.0.0-0'
```

The untagged npm install remains SDK 13. Keep that line for production AdCP 3.1 deployments until the 3.2 application and its counterparties have completed beta validation.

## Compound compliance capability gates

Starting with `@adcp/sdk@14.0.0-beta.4`, storyboard authors can declare
`requires_all_capabilities` with two or more capability predicates. Every
predicate is AND-composed, including a separate `requires_capability` when both
forms are present. The runner evaluates this applicability gate before runtime
requirements and advertised-tool gates, so tool availability cannot override a
capability the agent declined.

Compound gates also fail closed when the raw capability payload is unavailable;
advertising or auto-registering a related tool is not evidence of a capability
declaration. The legacy permissive fallback for an existing singular
`requires_capability` remains unchanged.

```yaml
requires_all_capabilities:
  - path: media_buy.propagation_surfaces
    contains: snapshot
  - path: creative.has_creative_library
    equals: true
```

An unmet predicate produces one whole-storyboard `not_applicable` result and no
steps are dispatched. Empty and single-entry lists fail during storyboard
loading; keep using `requires_capability` for a singular predicate.

## Upgrade checklist

1. Pin SDK 14 with the `beta` tag or an exact `14.0.0-beta.*` version. Do not rely on npm `latest` for beta rollout.
2. Move compact-first applications to `agent.negotiateMediaBuyLifecycle()` so the SDK owns capability-gated established fallbacks and their declared loss boundaries.
3. If you use request signing, propagate the negotiated or configured agent version into signing and verification. Expect standard padded Base64 plus mandatory `Content-Digest` only for AdCP 3.2.
4. Return `media_buy_status`, not top-level `status`, from new media-buy server handlers.
5. Add handlers only for the 3.2 tools your server actually implements and advertise the same set in capability discovery.
6. Re-run TypeScript against generated schema imports. Prefer per-tool type slices if the complete schema barrel exhausts the default Node heap.
7. Exercise mixed-version tests before rollout: 14→3.0, 14→3.1, 14→3.2 beta, and older buyer→14 server where applicable.
8. If a legacy brief may return products without a proposal, configure a durable `LegacyPurchaseContinuationStore`, stable `principalScope`, and application-owned `reconcileLegacyPurchase(record, exactInput)` callback before offering `continueLegacyPurchase()`. Keep reverse compact-seller → older-buyer handlers application-owned.
9. If established 3.0/3.1 proposal discovery and mutation can land on different processes, configure the same durable `EstablishedProposalStore`, stable `principalScope`, and stable non-secret `legacyPurchaseSellerSessionScope` on every coordinator. Add store-clock `completedAt` and `retainUntil` fields to refinement/decline completion tombstones, index `retainUntil`, and retain each proof for at least `ESTABLISHED_PROPOSAL_COMPLETION_TOMBSTONE_RETENTION_MS`. Conservatively backfill pre-upgrade tombstones to a future seven-day horizon, then run a database-clock sweeper that atomically prunes only expired rows. Recover submitted work with `reconcileEstablishedProposalTask({ account, sellerTaskId })`; see [Media-buy compatibility: durable established proposal state](./guides/MEDIA-BUY-3.2-COMPATIBILITY.md#durable-established-proposal-state). The bundled in-memory store is a non-durable reference implementation.
10. Upgrade durable idempotency storage before application traffic: add the nullable PostgreSQL `retain_until` column/index, preserve `IdempotencyCacheEntry.retainUntil`, and add atomic `putIfAbsent()`, `replaceIfPayloadHash()`, `replaceIfPayloadHashAndExpired()`, and `deleteIfPayloadHash()` to every custom backend.
11. Upgrade custom deferred-task storage with `putForSettlementOperationIfAbsent()`, `getBySettlementOperationId()`, and `replaceForSettlementOperationIfVersion()`. The initial token/index write and nested A→B index move must each be atomic.
12. Replace webhook emitter `operation_id` arguments with SDK-local `delivery_id` values and upgrade custom stores to `WebhookDeliveryStore`. One delivery ID binds one canonical payload and key; use a fresh delivery ID for each changed status observation while retaining the AdCP `operation_id` inside the payload.
13. Ensure custom 3.2 buyers include `push_notification_config.operation_id`, and update A2A integrations to keep the AdCP registration in skill parameters even when native A2A push configuration is also present.
14. Treat failed/rejected task results as canonical terminal artifacts when `include_result` is requested; do not discard them while preserving only the summary error.
15. Persist the complete `ScopedTaskRef` for out-of-process task settlement and acknowledge durable queue items only after `applied` or after reading back an `already_terminal` task and proving its exact result/error artifact. Matching terminal status alone is insufficient. Retry or dead-letter scoped misses and conflicting terminal outcomes. Upgrade populated PostgreSQL task registries with the phased [`getDecisioningTaskRegistryScopeV1Upgrade()` runbook](./migration-task-registry-scoping.md#populated-postgresql-upgrade), not application-boot bootstrap DDL.
16. For out-of-process settlement, return `ctx.handoffToTask(producer, { settlement: 'external' })`; the producer must durably queue the complete handle before returning, and the framework withholds `submitted` until that commit succeeds. For a push-enabled task, configure `createPostgresTaskSettlementCoordinator()` on the same PostgreSQL pool as the task registry and use `completeScopedPushTask()` / `failScopedPushTask()`. Run the webhook recovery outbox migration and recovery worker; the polling-only scoped helpers still reject push tasks. See [task registry scope migration](./migration-task-registry-scoping.md#out-of-process-settlement).
17. Upgrade to Node `^20.19.0 || >=22.12.0`, whose two boundaries enable the `require(esm)` support needed by the SDK's CommonJS dependency graph. Node 21 and Node 22.0–22.11 are not supported. Keep Undici 6 for the fully supported configuration, or use the tested best-effort Undici 7 override on Node 20.19+. See the [Node/Undici compatibility policy](./guides/NODE-UNDICI-COMPATIBILITY.md).

### Webhook delivery identity and retry horizons

SDK 14 separates the emitter's local delivery identity from the AdCP
operation correlation carried on the wire. Exact retries use the same
`delivery_id`, complete payload (including its original `timestamp`), and
`idempotency_key`. A changed payload or later lifecycle observation uses a
fresh `delivery_id` and therefore a fresh delivery key even when its payload
retains the same AdCP `operation_id` and `task_id`.

```ts
await ctx.emitWebhook({
  url: pushNotificationConfig.url,
  payload: {
    operation_id: pushNotificationConfig.operation_id,
    task_id: sellerTaskId,
    task_type: 'create_media_buy',
    status: 'completed',
    timestamp: terminalObservedAt,
    result,
  },
  delivery_id: `create_media_buy:${sellerTaskId}:completed`,
});
```

The old `operation_id` emitter argument incorrectly combined these namespaces
and is no longer accepted. `WebhookDeliveryStore.claim()` must atomically
return either the winning immutable `{ status: 'bound', idempotencyKey,
payloadFingerprint, firstAttemptAtMs, retainUntilMs }` binding or a permanent
`{ status: 'retired' }` tombstone. The backend uses its authoritative clock,
retains the full binding through the advertised horizon, and MUST NOT make a
previously claimed delivery ID look unused after expiry. Store keys include
trusted publisher and tenant scopes in addition to the delivery ID.
Multi-replica publishers must provide a shared durable implementation; the bundled
`memoryWebhookDeliveryStore()` is single-process only. The deprecated
`WebhookIdempotencyKeyStore` and `memoryWebhookKeyStore()` names remain aliases
for source discovery, but custom implementations must adopt the new binding
contract.

Production publishers must also implement `WebhookDeliveryRecovery`. Its
`checkpoint()` durably stores the exact destination, canonical payload values
(including the original body timestamp), authentication reference, and retry
policy before the binding claim or first POST; it rejects conflicting reuse and
arranges replay of unsettled entries after restart. Its `settle()` removes or
terminalizes the outbox entry only after 2xx delivery or a non-retryable
outcome. Retryable exhaustion stays pending. Encrypt authentication material at
rest. Without this outbox, the agent cannot truthfully advertise a webhook
delivery retry horizon after a process crash.

SDK 14 now provides the durable building blocks directly. Use
`pgWebhookDeliveryStore()` or `redisWebhookDeliveryStore()` for immutable
delivery bindings. Pair it with `pgWebhookDeliveryRecoveryBackend()` or
`redisWebhookDeliveryRecoveryBackend()` through
`createWebhookDeliveryRecovery()`. PostgreSQL deployments must run both
`getWebhookDeliveryMigration()` and
`getWebhookDeliveryRecoveryMigration()`. Production PostgreSQL deployments
must configure deployment-unique table names (or explicitly acknowledge a
dedicated database). Redis deployments have the same requirement for key
prefixes.

The recovery backends checkpoint the first exact snapshot, reject conflicting
reuse, atomically lease the initial live send, use backend-authoritative clocks, and expose version-fenced lease,
renewal, release, and settlement primitives. `pollWebhookDeliveryRecovery()`
runs one bounded recovery pass and leaves scheduling, retry policy, and
observability to the application. Use `errorRetryAfterMs` for thrown callback
backoff and `onError` for callback or lease-renewal telemetry; retired or
out-of-horizon deliveries are terminalized automatically. Supply a
`WebhookAuthenticationAdapter` for
bearer or HMAC deliveries; it stores ciphertext or an opaque secret reference
plus a stable non-secret equality fingerprint. The adapter must authenticate
the supplied tenant/destination/snapshot context. Settled records redact payload
and protected secret references. The application still owns KMS
keys, secret management, tenant authorization/RBAC, and management APIs or UI.
For crash-safe task settlement, `createPostgresTaskSettlementCoordinator()`
explicitly removes the top-level validation `token` from the persisted payload
and protects it with the same adapter under the distinct `payload_token`
purpose before writing the outbox. Generic recovery checkpoints preserve
payload fields named `token`; use `recovery.prepare(...,
{ protectPayloadToken: true })` only for a protocol field known to be secret.
The legacy transport-authentication adapter context keeps `purpose` undefined
for upgrade-compatible KMS AAD.

`deliveryRetryHorizonSeconds` defaults to 86,400 seconds and accepts 86,400
through 604,800. `createAdcpServer()` advertises the configured value under
`webhook_signing.delivery_retry_horizon_seconds`, rejects a changed payload
under an existing delivery ID, and refuses the retained key after that
horizon. Do not mint a new delivery ID merely to extend a failed delivery; a
fresh ID is only for a protocol-defined re-emission or genuinely distinct
observation.

Production direct `createWebhookEmitter()` callers must provide a stable
`publisherScope`. A production publisher may omit `tenantScope`; the resulting
unbound emitter refuses direct `emit()` calls, so bind every authenticated
request or durable job with `forTenantScope(trustedTenant)` first. Callers that
provide `tenantScope` at construction retain the existing directly usable
behavior. `createAdcpServer()` uses its trusted server name for the publisher
scope and derives tenant scope only from resolved account/session/authentication
context. A genuinely single-tenant server may configure
`webhooks.tenantScope`; otherwise production emission without trusted scope
fails before durable checkpointing or delivery. Request and payload fields
never select this namespace.

### Legacy continuation store upgrade

SDK 14 tightens the durable continuation contract. Custom stores must make
`recordSubmittedTask()` an atomic first-writer-wins bind: the first seller task
ID and exact same-ID retries return `true`; a different ID returns `false` and
never overwrites it. The seller task ID and any pending callback task ID must
also match regardless of which is written first. `complete()` now distinguishes
the installing `completed` writer from an exact `duplicate` and a divergent
`conflict`; when a pending callback already exists, it atomically promotes and
returns that earlier terminal winner as `pending_completed` with required
settlement metadata instead of the caller's stale candidate.

Replica-safe callback recovery requires implementing
`getByCallbackOperationId()`, `recordPendingSettlement()`,
`claimPendingSettlementPublication()`, `releasePendingSettlementPublication()`,
`acknowledgePendingSettlement()`, and `recordDeferredTaskToken()` together;
partial implementations are rejected. The token binding links the purchase
record to the SDK's distinct deferred-state token so a callback can advance the
correct terminal checkpoint after restart. Its fourth argument is the expected
prior deferred token: initial binding expects no prior token, nested pauses
compare-and-swap the exact prior token, stale writers return `false`, and an
exact already-installed retry returns `true` without overwriting it.
The deferred store independently indexes the current token by committed
operation ID. That index is the recovery source of truth if a process exits
after persisting an initial or nested pause but before this continuation-store
binding completes. An exact operation retry reconciles the continuation-store
token to the indexed generation and returns the current pause without
redispatching already-consumed input.
New atomically indexed records carry
`settlementOperationRouteRequired: true`. Custom stores and serializers must
preserve that discriminator on every replacement so routed same-key updates
renew and fence the operation index together with the token. Records written by
earlier prereleases without the marker remain readable through the legacy
exact-token path.
For callback-capable operations, only the exact current deferred token on an
unexpired claimed operation can dispatch seller continuation input. Ambiguous,
completed, expired, stale, unlinked, or coordinator-less routes fail closed;
pending and terminal checkpoints can still be recovered without redispatch.
The default reference store implements callback recovery, so a committed A2A
pause requires `SingleAgentClient.deferredStorage`. Without deferred storage,
the SDK fails that pause closed rather than exposing an in-process continuation
that could race a callback. To retain in-process pause behavior without durable
storage, use a polling-only continuation store that omits all six callback
methods.
The publication claim is an atomic renewable lease over the exact pending
settlement. A live different owner returns `false`, the same owner may renew,
an expired owner may be replaced, and release removes only the exact owner.
Acknowledgement of a pending entry requires that exact owner. This lets a
replica reclaim an SDK polling-completion outbox after a crash without racing a
healthy publisher. Publication handlers remain idempotent because a stalled or
partitioned owner cannot revoke side effects after lease expiry.
Sender callback inbox writes still stop at `replayExpiresAt`. An already
dispatched seller task may finish later, so an SDK-owned polling/inline
publication fence may be installed after that time and must remain retained
until exact-owner acknowledgement; expired completed records with a pending
SDK outbox are not cleanup-eligible.
Every accepted sender- or SDK-owned terminal outbox extends `replayExpiresAt`
by at least `LEGACY_PURCHASE_PUBLICATION_PROOF_RETENTION_MS` from admission.
This keeps a callback admitted near the former deadline retryable through
handler execution and cross-store finalization.
Acknowledging an SDK-owned outbox must extend `replayExpiresAt` by at least
`LEGACY_PURCHASE_PUBLICATION_PROOF_RETENTION_MS` from acknowledgement. The SDK
verifies that extension through both primary and callback lookups so a crash
before deferred-checkpoint finalization remains recoverable.
Cleanup also must not remove any pending outbox while its publication lease is
unexpired; an expired sender-owned outbox becomes reclaimable only after both
its replay deadline and active lease end.
The acknowledgement atomically replaces the outbox entry after application
handler dispatch: it clears `pendingSettlement` and retains a stable, nonempty
`acknowledgedSettlementFingerprint` for that exact settlement through
`replayExpiresAt`. Both lookup methods must return that proof, and exact ACK
retries must validate it. This publication proof prevents a handler from being
invoked again if the legacy-store ACK succeeds but deferred-checkpoint ACK
fails. When the exact completed result has no pending outbox entry, ACK installs
the same proof after successful publication. Implementers should call the
exported `legacyPurchaseSettlementFingerprint()` helper rather than reproduce
its canonicalization. The proof binds the operation, seller task, task type,
and terminal value; it intentionally excludes the webhook delivery event key
so authenticated redelivery may rotate that identity. A transient handler failure remains retryable. Stores that implement none of
these methods remain polling-only, and the
SDK suppresses task webhooks for those operations. Share the durable webhook
registration store between replicas (and the replay store for RFC 9421).
Completed-operation replay retention is at least seven days.
`legacyPurchaseOperationTtlMs` configures unresolved-operation monitoring and
may lengthen, but never shorten, that replay retention.

SDK 14 also moves new webhook dedup claims and completion markers to a distinct
v2 hashed-sender namespace while read-only probing unexpired SDK 13 v1
raw-sender markers. This preserves completed fences across the upgrade, but it
does not make mixed-version receivers safe: SDK 13 and SDK 14 claim different
keys and can dispatch the same callback once each. Stop accepting webhook
traffic, drain in-flight handlers, upgrade all webhook receiver replicas
together, and then restart webhook traffic. Mixed SDK 13/14 webhook receivers
are unsupported.

Seller pauses are now protocol-specific. A2A can invoke an input handler or
return a resume closure only for a live `input-required`/`auth-required` A2A
Task, using its transport `Task.id`; the separate AdCP task handle remains for
`tasks/get` polling. Completed A2A Tasks with artifact-level pauses and MCP
responses expose `input-required` or `auth-required`
without invoking the handler and without `deferred`; use an
application/protocol-specific recovery path.
Pre-upgrade persisted A2A deferred records that lack an A2A transport task ID are
rejected and removed on resume rather than replayed as a fresh mutation.

## Existing 3.x calls remain valid

No mechanical rewrite is required for code that stays on the established lifecycle:

```ts
const products = await agent.getProducts({
  buying_mode: 'brief',
  brief: 'Reach outdoor enthusiasts in Italy',
});

await agent.createMediaBuy(/* canonical SDK 13 request */);
```

SDK 14 retains the canonical/legacy projection layer and the exact compatible-version list for released AdCP 3.0 and 3.1 versions. Keep using the explicit `*Legacy()` methods only for raw wire migration or conformance tooling, just as in SDK 13.

One already state-changing established-tool variant gains optional-key replay
semantics under 3.2:
`get_products({ buying_mode: 'refine', refine: [{ scope: 'proposal', action:
'finalize', ... }] })`. SDK 14 clients attach an `idempotency_key`; preserve it
for an exact retry. SDK 14 servers cache the finalize variant when a valid key
is supplied. The compatibility schema still permits older callers to omit the
key, but those calls cannot receive cache-backed replay protection. Ordinary
discovery and non-finalizing refinement remain read-only. Sellers using the
proposal-manager framework must wire the same durable idempotency store used
by their other commercial mutations.

SDK 14 also hardens replay-cache isolation by including the tool and trusted
resolved session/account identity in canonical replay identity. The original
SDK 14 key shape retained the SDK 13 scope and bare `authInfo.clientId`
principal format. The PostgreSQL security hardening release additionally
prefixes requests served through `serve()` with a canonical endpoint scope;
that stronger key does not match pre-upgrade durable entries. Before deploying
that release, stop accepting mutations, drain in-flight work, and wait at least
the full configured replay TTL after the last accepted mutation (or migrate or
dual-read the old keyspace). Upgrade all instances together: a mixed rolling
deployment can execute the same retry once under each key shape. The new 3.2
compact mutation tools use
credential-kind-prefixed principals such as `oauth:<client_id>`,
`api_key:<key_id>`, or `agent:<agent_url>` and do not fall back to session or
account identity. Those tools have no SDK 13 cache entries to migrate.

If you supply `resolveIdempotencyPrincipal`, your resolver remains
authoritative for both established and compact tools; keep its output stable
across the deployment or deliberately dual-read/migrate your backing store.
Because SDK 14's stronger payload identity differs,
a retry against an SDK 13 entry returns `IDEMPOTENCY_CONFLICT` instead of the
old cached body; reconcile by natural key rather than minting a replacement
key until the original replay TTL expires. New entries cannot replay a body
across tenants or tools.

### Upgrade durable idempotency backends before application code

SDK 14 adds an absolute physical-retention fence to every idempotency entry.
Apply the PostgreSQL table migration before starting an SDK 14 server:

```sql
ALTER TABLE adcp_idempotency
  ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_adcp_idempotency_retain_until
  ON adcp_idempotency(retain_until, expires_at);
```

Use the table name configured for each agent. `getIdempotencyMigration()` emits
the complete current schema for new installs; readiness now probes
`retain_until`, so starting application traffic against the old shape fails
closed. The column remains nullable for a rolling database migration, while
reads and cleanup conservatively retain old-writer rows through the configured
legacy grace.

Custom `IdempotencyBackend` implementations must preserve the entry's
`retainUntil` value and implement atomic `putIfAbsent()`,
`replaceIfPayloadHash()`, `replaceIfPayloadHashAndExpired()`, and
`deleteIfPayloadHash()`. Upgrade all custom
adapters before passing them to `createIdempotencyStore()` or `webhookDedup`;
SDK 14 rejects incomplete backends at construction. Redis adapters must derive
relative expiry from the absolute horizon using Redis server time, not an
application-process clock, so clock skew cannot evict the fence early.
`replaceIfPayloadHashAndExpired()` must test the expected payload hash and
logical expiry in the same database operation, using backend time and treating
an entry expiring in the current second as live. A read followed by ordinary
payload-hash replacement is not equivalent: renewal can preserve the hash and
create an ABA takeover window.
`putIfAbsent()` is strictly absent-only in SDK 14; it must return `false` for
every retained record, including a logically expired one. All expiry reclaim
uses the exact-generation method above so an earlier absent read cannot erase a
newer claim that appears and expires while the caller is awaiting another
store operation.

Audit every Redis-backed SDK store during the upgrade. Outside development and
test, the idempotency backend, `RedisReplayStore`, and
`redisCtxMetadataStore` now require a deployment-unique `keyPrefix` when a
database is shared. An omitted, blank, or SDK-default prefix fails startup.
For a Redis database operationally dedicated to one deployment, pass
`acknowledgeIsolatedDatabase: true`; `suppressDefaultPrefixWarning` only
controls development/test warnings and is not a production acknowledgement.

## Adopt one compact-first lifecycle

The compact flow is not a rename of the established tools. SDK 14 provides a
compatibility coordinator so application code can express one compact-first
intent while the SDK selects the remote lifecycle before dispatch:

```ts
const lifecycle = await agent.negotiateMediaBuyLifecycle();

const products = await lifecycle.listProducts({
  brand: { domain: 'example.com' },
  max_results: 25,
});

const proposed = await lifecycle.requestProposals({
  brand: { domain: 'example.com' },
  brief: 'Reach outdoor enthusiasts in Italy',
});
```

Every result has a `compatibility` report with the negotiated version,
selected lifecycle, exact tools used, `native` / `lossless_projection` /
`lossy_projection`, warnings, and named losses. Compact tools are preferred
when advertised. `preferredLifecycle: 'established'` exists for a forced
dual-surface test lane, but only when capability discovery also proves that
the corresponding established tool is callable. A compact-only seller fails
that diagnostic lane with a typed error before dispatch.

Existing code that continues to call `getProducts`, `createMediaBuy`, and
`updateMediaBuy` remains on that established lifecycle; it is not routed
through the coordinator. A compact-first `listProducts` call becomes
`get_products` against a 3.0/3.1 seller and remains `list_products` against a
3.2 seller that advertises it. Purchase completion is intentionally stricter:
the older mutation cannot enforce 3.2 feed/pricing fencing or proposal digest
binding, so the coordinator rejects by default rather than claiming identical
semantics.

Lossy mutations fail before transport by default. For example, an established
seller cannot atomically enforce a compact feed/pricing snapshot. If the
application's own reconciliation policy accepts that exact limitation, opt in
by name:

```ts
const lifecycle = await agent.negotiateMediaBuyLifecycle({
  allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
  principalScope: authenticatedPrincipalId,
});
```

Use a stable, non-secret `principalScope` derived from authenticated,
server-controlled identity for established proposal acceptance; never take it
from buyer-supplied request content. Without it, the coordinator deliberately
does not cache executable proposal snapshots and acceptance fails before
mutation. Snapshot quotas are isolated per principal. One `AgentClient`
retains at most 256 active principal partitions; empty inactive partitions are
reclaimable because terminal history is retained separately in 256 lazily
allocated, salted 256 KiB tombstone segments (64 MiB maximum). A principal can
consume only its assigned segment. A segment collision can cause a fail-closed
false positive for another principal, but never shares proposal data or
executable authority. Treat `dispose()` as terminal: in-flight results and
saved task continuations reject after disposal. If an established acceptance
has an unknown outcome, compact decline, refinement, and native acceptance
remain fenced until natural-key reconciliation; only an exact retry within an
advertised idempotency window may be sent.

Proposal hard constraints, alternatives, criteria, and amendment kinds are
never softened into legacy discovery filters. A requested proposal digest is
never invented or silently dropped. Unsupported guarantees throw
`MediaBuyLifecycleCompatibilityError` with `code: 'UNSUPPORTED_FEATURE'`, the
operation, negotiated version, named losses, and recovery guidance before any
mutation is sent.

An ordinary 3.0/3.1 proposal may not contain any digest or compact commercial
terms. The facade returns that proposal unchanged and can still execute the
same legacy `create_media_buy(proposal_id=...)` path, but only after the caller
opts into `proposal_terms_digest_not_enforced`,
`proposal_terms_digest_unavailable`, and
`proposal_snapshot_not_immutable`. If the legacy proposal has no expiry,
`proposal_hold_not_verifiable` is a fourth required opt-in. Supply the original
brand and flight through `established_fallback`; this is buyer provenance, not
a seller snapshot. Native 3.2 acceptance ignores that fallback and still
requires the seller digest.

The compatibility facade also rejects fields that the negotiated established
schema cannot represent. In particular, 3.2-only targeting, allocation,
budget-cap, bidding, pacing, governance, and opportunity controls are never
sent to a 3.0/3.1 tool. A direct compact `total_budget` is also rejected below
3.2: legacy direct-buy schemas do not carry the same top-level commitment
(proposal-mode budget support is separate). Shared per-purchase fields are
projected according to the negotiated schema, including 3.1+
`format_option_refs`; no field is silently stripped. During proposal
acceptance, caller-supplied budget,
budget-cap, timezone, or purchase-order values must match any digest-bound
seller terms; a conflict fails before `create_media_buy`.

For v2.5 specifically, proposal operations, `get_media_buys`, pagination,
cancellation, and v3-only package controls return typed unsupported errors.
Supported pause/resume updates require explicit `revision_not_atomic` opt-in
because v2.5 has no optimistic revision token.

Run the same compact CLI storyboards against established sellers with
`--media-buy-lifecycle-compat`. Use `--media-buy-compat-losses` only for the
exact guarantees your application has approved, and add
`--force-established-media-buy-lifecycle` to exercise a dual-surface 3.2
seller's fallback lane. For proposal flows, pass a stable non-secret
`--media-buy-principal-scope`; if omitted, the CLI creates a run-local scope,
which intentionally cannot authorize acceptance from another run.

Compatibility projection follows asynchronous continuations too. A submitted
or deferred proposal response is not treated as executable evidence until its
completion succeeds; `waitForCompletion()` and `resume()` project and retain
the completed proposal under the same compatibility and principal scope.

Use the generated request types or the narrow imports under
`@adcp/sdk/types/<tool>` for exact compact fields. Preserve the same request
and key for a transport retry; a changed commercial intent needs a new key.
The coordinator selects one mutation tool before transport and never retries
through the other lifecycle after an ambiguous failure.

For proposal refinement, validate the advertised limits and supported dimensions, keep hard constraints distinct from legacy discovery filters, and re-check `expires_at` immediately before acceptance. See [AdCP 3.2 proposal negotiation](migration-adcp-3.1-to-3.2-proposals.md).

AdCP 3.2's exact MCP schema also requires `account` at the top level of every
`comply_test_controller` request. Move a legacy
`context: { account, session_id }` controller call to
`{ account, context: { session_id } }`. The account remains an assertion of
intent; the seller must resolve it through its trusted account store and admit
only a persisted sandbox or mock account.

## Request-signing profiles are versioned

SDK 13 used the legacy AdCP 3.0/3.1 representation. SDK 14 selects between two profiles:

| Agent version | `Signature` encoding | `Content-Digest` encoding | Digest coverage |
|---|---|---|---|
| AdCP 3.0 or 3.1 | unpadded Base64URL | padded standard Base64 | governed by the legacy coverage policy |
| AdCP 3.2 | padded standard Base64 | padded standard Base64 | mandatory |

High-level A2A/MCP clients carry the configured agent version automatically. Low-level signing integrations should pass their trusted version context and can inspect the signature encoding with `requestSigningEncodingForVersion()`. For SDK 13 source compatibility, a low-level verifier with no `adcpVersion` accepts either signature encoding and applies its configured digest-coverage policy; an explicit trusted 3.2 pin keeps mandatory digest coverage.

For a staged server rollout, set the internal verifier option
`signedRequests.covers_content_digest: 'either'` to accept SDK 13 Base64URL
signatures and SDK 14's 3.2 encoding on the same endpoint. Continue advertising
`covers_content_digest: 'required'` in the 3.2 capability document; SDK 14
projects that strict public contract automatically. Move the internal verifier
to `required` after legacy callers are gone.

Do not select a signing profile from a version value inside an unverified request body or header. On the server, bind the version to the endpoint, tenant, or authenticated agent configuration. Webhook signatures do not move to the 3.2 request profile.

Low-level `verifyRequestSignature()` calls that omit `adcpVersion` tolerate both
the legacy Base64URL and 3.2 RFC 8941 Base64 serialization so frozen 3.0/3.1
integrations do not inherit the SDK's own protocol pin. This does not relax
digest policy: `capability.covers_content_digest` remains authoritative. Pass a
trusted `adcpVersion` whenever one is available for deterministic diagnostics.

## Cross-role governance is capability-gated

AdCP 3.2 governance authorizes one exact downstream action. A buyer-side
`GovernanceMiddleware` now checks only tasks the target advertises under
`adcp.governance_enforcement.tasks` with `signed_context` mode **and** the
`governance.campaign` experimental feature marker. Intent checks
carry `plan_id`, `target_agent`, `tool`, and the exact payload; they never reuse
`governance_context`. An approved check adds the returned compact JWS to the
downstream payload. A conditions verdict carries only `consultation_context`
and must be adjusted and re-checked before it authorizes anything.

Modern buyer configuration needs a stable caller URL. Conditional tasks use
`resolveApplicability` when deciding whether a stateful change increases a
commitment, and `resolveIntentDetails` supplies the authoritative ceiling for
tasks whose amount is not derivable from the request:

```ts
const client = new AgentClient(seller, {
  governance: {
    campaign: {
      agent: governanceAgent,
      planId,
      callerUrl: 'https://buyer.example/mcp',
      resolveApplicability: async (tool, payload) => {
        if (tool !== 'update_media_buy') return true;
        const current = await mediaBuyStore.get(String(payload.media_buy_id));
        return payload.total_budget != null &&
          payload.total_budget.amount > current.total_budget;
      },
      resolveIntentDetails: async (tool, payload) => {
        if (tool !== 'update_media_buy') return {};
        const delta = await computePositiveBudgetDelta(payload);
        return { proposedCommitment: { amount: delta.amount, currency: delta.currency } };
      },
    },
  },
});
```

The SDK handles stateless pause, cancel, deactivate, and creative-estimate
exemptions itself. If a conditional request needs seller state and no resolver
is installed, it is governed conservatively. Direct `TaskExecutor` callers
must pass the target capability result; configured governance fails closed
when it is absent.

Services verify the token before starting a side effect:

```ts
import {
  InMemoryGovernanceReplayStore,
  createAdcpGovernanceEnforcementMiddleware,
} from '@adcp/sdk/server';
import { HttpsJwksResolver } from '@adcp/sdk/signing/server';

const enforceGovernance = createAdcpGovernanceEnforcementMiddleware({
  expectedIssuer: 'https://governance.example/mcp',
  expectedAudience: 'https://seller.example/mcp',
  jwks: new HttpsJwksResolver('https://governance.example/.well-known/jwks.json'),
  replayStore: new InMemoryGovernanceReplayStore(),
});

await enforceGovernance(
  {
    token: params.governance_context,
    authenticatedCaller: principal.agentUrl,
    task: 'create_media_buy',
    payload: params,
    actualCommitment: { amount: params.total_budget.amount, currency: params.total_budget.currency },
  },
  () => commitMediaBuy(params),
);
```

Use a shared atomic `GovernanceReplayStore` in multi-replica production
services; the in-memory implementation is for a single process. The verifier
checks critical markers, signature and key purpose, issuer, audience,
authenticated caller, task, JCS payload hash, currency, amount ceiling, time
window, revocation, and one-time `jti` consumption. Existing
`media_buy.governance_aware` online-consultation integrations remain the 3.0/
3.1 compatibility path; do not infer cross-role enforcement from that legacy
boolean.

The server-specific middleware returns a structured `PERMISSION_DENIED` AdCP
response for missing, invalid, expired, or conflicting authorization. The
framework-neutral `createGovernanceEnforcementMiddleware` throws
`GovernanceAuthorizationError`; use it only when your framework explicitly
maps that error to a permission denial. Resolve exact retries from the
service's idempotency cache before invoking governance verification: a
consumed authorization is always rejected, and the middleware never invokes
the side effect twice. Without a fresh combined key-and-JTI revocation
resolver, intent-token lifetime is capped at 15 minutes.

Seller-side `GovernanceAdapter.checkCommitted()` accepts the legacy
plan-addressed request shape during 3.x. The modern shape supplies
`governanceContext`; purchase commitment is derived from
`plannedDelivery.total_budget` and `currency`, while modification calls must
supply the seller-computed positive `executionCommitment`. Governance-agent
transport failure now throws `GovernanceAdapterError` with
`governance_agent_unreachable` instead of being reported as a policy denial.
Catch it at the server handler boundary and return
`governanceUnavailableError()`, which emits the required transient
`GOVERNANCE_UNAVAILABLE` wire error.

## Server handler additions

`createAdcpServerFromPlatform()` routes the new compact lifecycle through
`platform.mediaBuyLifecycle`, including `proposalRefinement` capability
metadata for `refineProposals`. Keep `platform.sales` beside it when the same
seller must accept 3.0/3.1 callers. Both facades should call the same business
services rather than maintaining parallel commercial state.

The generated handler maps cover:

- `list_products`, `request_proposals`, `refine_proposals`, `decline_proposals`
- `buy_products`, `accept_proposal`, `control_media_buy`
- `report_plan_adjustment`
- `sync_agent_notification_configs`

On a 3.2 server, the default `mcpToolProfile: 'auto'` advertises only the
intersection of registered tools and the active spec `media-buy` profile. The
deprecated names remain callable compatibility routes. Use
`mcpToolProfile: 'all'` only for migration diagnostics. MCP `tools/list`
includes `_meta.adcp_version` and `_meta.adcp_profile`, and each framework tool
includes `_meta.adcp_version`.

An SDK 14 server may therefore continue serving 3.0/3.1 clients through the
established tool names without steering new MCP clients toward them. Verify
both facades use the same authorization, tenant isolation, idempotency, and
commercial source of truth. The exact surface comparison and test matrix are
in [AdCP 3.2 media-buy lifecycle compatibility](guides/MEDIA-BUY-3.2-COMPATIBILITY.md).

For create/update media-buy handlers, use `media_buy_status` for the business state:

```ts
return {
  media_buy_id,
  media_buy_status: 'active',
  // ...response fields
};
```

The outer `status` remains the asynchronous task state (`completed`, `working`, `submitted`, `input_required`, or `deferred`).

## Notification and plan-adjustment tools

`syncAgentNotificationConfigs()` replaces the caller's desired agent-level notification configuration declaratively. Treat clear, pause, and replace as authenticated configuration mutations, honor revision fencing, and never merge secrets into logs or `ctx_metadata`.

`reportPlanAdjustment()` is an authenticated, append-only governance record. Replays must be idempotent, but a changed adjustment is a new intent. Scope storage and idempotency to the authenticated tenant/principal rather than a request-supplied account alone.

## Type and schema changes

Regenerated 3.2 types include new tools, error codes, canonical formats, measurement surfaces, and more exact intersections/tuples. If application code imported broad generated types or runtime schemas, expect TypeScript to reveal newly exhaustive unions.

Tool JSON Schema discovery is now version-aware. Use the schema subpath when
an agent or gateway must publish the exact bundled contract for a negotiated
release:

```ts
import { getToolInputSchema, getToolResponseSchema } from '@adcp/sdk/schemas';

const request = getToolInputSchema('create_media_buy', { adcpVersion: '3.0' });
const response = getToolResponseSchema('create_media_buy', {
  adcpVersion: '3.2.0-beta.10',
  variant: 'sync',
});

if (!request || !response) throw new Error('Tool schema is not present in the selected bundle');
console.log(request.resolvedVersion, request.schema);
```

The returned record reports the requested version, selected bundle key, and
exact release recorded by that bundle. A missing bundle throws an actionable
configuration error; a tool or response variant absent from an installed
bundle returns `undefined`. Neither case silently falls back to the current
schema.

Every `TaskResult.metadata` now exposes the selected seller wire generation as
`serverVersion: 'v2' | 'v3'`. `serverVersionSynthetic` distinguishes an
authoritative capability declaration (`false`) from the SDK's compatibility
fallback (`true`). Both fields survive submitted/deferred continuations and
durable restart recovery. `adcpVersion` remains the distinct, release-precision
value echoed by a seller response.

The v2.5 `get_products` response adapter also accepts explicitly zoned legacy
forecast timestamps, including offset variants and single `$date`/`value`
wrappers. It converts them to UTC RFC 3339 without losing fractional precision;
ambiguous or unzoned values remain untouched, and the preserved seller wire
object is not mutated.

SDK 14 also adds semantic refinements to public object schemas. Behavior when
composing a refined schema varies across supported Zod 4 releases: `.extend()`
may throw during module initialization or may succeed with version-specific
semantics. When adding application-owned fields to an SDK schema, use
`.safeExtend()` consistently:

```ts
import { z } from 'zod';
import { BiddingPolicySchema } from '@adcp/sdk/schemas';

const ApplicationBiddingPolicySchema = BiddingPolicySchema.safeExtend({
  application_policy_id: z.string(),
});
```

Keep the SDK refinements in place: they enforce protocol rules that structural
object validation alone cannot express. `.partial()` is also version-dependent:
it may reject a refined object or return a structural partial without the
original checks. Define application patch schemas separately, merge the patch
with a complete object, and parse that result through the full SDK schema before
using it. Do not rebuild from `.shape`, because doing so silently discards the
protocol checks.

The media-buy compatibility coordinator does not expose `unknown[]` rows or a
`Record<string, unknown>` escape hatch. Product and proposal collections use
`CompatibleProduct` / `CompatibleProposal`, proposal methods return separate
request/refine/decline response types with stable `operation` and `outcome`
discriminants, and each `raw` member is the SDK-returned compact or
canonical-established source response union. Established `raw` is a
`CanonicalGetProductsResponse` with `projection.diagnostics`, not untouched
seller emission; use `getProductsLegacy()` outside the coordinator only when
raw legacy wire inspection is actually required. `CompatibleRefinementResult` restores the canonical proposal
base on revised, partial, and finalized result arms at this boundary; the
underlying beta.3 generator correction is tracked separately in #2619. The
coordinator validates that full canonical child shape at runtime, correlates
ordered compact decline results whether or not they echo `proposal_id`, and
blocks projected legacy acceptance while a decline for that proposal remains
unresolved. Refinement likewise fences every source before dispatch and restores
it only for a verified compact `unable`; ambiguous or malformed refinement paths
retire the source rather than permitting stale acceptance. These checks also run
on submitted, tracked, deferred, and task-update completions before proposal
state is cached or a mutation fence is released.
The result union is status-aware: narrow `result.status === 'completed'` before
reading those completed-only discriminants. Intermediate and failure branches
retain the SDK-returned source response instead of fabricating a proposal outcome.

Use focused imports where possible:

```ts
import type { ControlMediaBuyRequest } from '@adcp/sdk/types/control-media-buy';
import { ControlMediaBuyRequestSchema } from '@adcp/sdk/schemas';
```

The repository's own build allocates an 8 GB TypeScript heap for the full surface. Focused application imports avoid paying that cost.

## Rollout and rollback

Keep separate compatibility lanes in CI:

- SDK 14 client → AdCP 3.2 beta reference agent
- SDK 14 client → representative AdCP 3.1 seller
- SDK 14 client → representative AdCP 3.0 seller
- supported 3.0/3.1 client → SDK 14 server

Canary the beta by endpoint or tenant. Rolling back to SDK 13 is safe only while the application continues to preserve the established 3.x tool path and has not made its storage model depend exclusively on a 3.2-only workflow.
