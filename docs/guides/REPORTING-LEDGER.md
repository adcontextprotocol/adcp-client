# Seller Reporting Ledger

`@adcp/sdk/reporting/ledger` turns a conforming reporting source into durable seller-side Reliable Reporting Core. It is separate from the buyer-side `reconcileReporting` API.

## Recommended: install the lifecycle service

`createReliableReportingService` is the adapter-first production path. A
provider adapter supplies one bounded slice fetch and two immutable offering
descriptions; the service reuses the PostgreSQL ledger, source executor,
producer, handlers, and decisioning-platform account resolver.

```ts
import { Pool } from 'pg';
import { PostgresReportingLedgerStore } from '@adcp/sdk/reporting/ledger';
import { createReliableReportingService } from '@adcp/sdk/reporting/service';
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresReportingLedgerStore(pool, {
  acknowledgeIsolatedDatabase: true,
});

const reporting = createReliableReportingService({
  store,
  adapters: {
    // These descriptions are immutable declarations owned by your adapter.
    gam: { sourceOffering: gamSourceOffering, deliveryOffering: gamDeliveryOffering,
      fetchSlice: (slice, ctx) => gam.fetchDeliverySlice(slice, ctx) },
  },
  contact: { name: 'Reporting operations', email: 'reporting@example.com' },
  automatedRecoveryWindowSeconds: 86_400,
  statusRetentionDays: 90,

  // `account` is the framework-resolved account, not request.account.
  resolveSource: account => ({
    adapterId: 'gam',
    sourceScope: { network_id: account.ctx_metadata.gam.networkId },
    sourceTimezone: account.ctx_metadata.gam.reportingTimezone,
  }),
  // Resolve from trusted commercial/account state. The result is frozen into
  // the generation and every obligation; no request-body fallback exists.
  resolveCurrency: account => account.ctx_metadata.gam.currency,
  // The authorization boundary for shared upstream networks: return only the
  // constituents this account may report on. Never echo the declaration.
  resolveCoverage: async account => ({
    constituents: await bookings.authorizedReportingConstituents(account.id),
  }),
  resolveConsumerId: ctx => {
    if (!ctx.agent) throw new Error('Authenticated buyer-agent registry required');
    return ctx.agent.agent_url;
  },
});

await pool.query(reporting.setup.migrations[0]);
const installedPlatform = reporting.install(platform);
const server = createAdcpServerFromPlatform(installedPlatform, serverOptions);

reporting.start({ intervalMilliseconds: 60_000, deploymentWide: true });
process.once('SIGTERM', () => void reporting.stop());
```

The service advertises Reliable Reporting Core only. An inline adapter cannot
turn on Managed Delivery, Reconciled Billing, receipts, webhook activity, or
reporting notifications. `sync_reporting_status` is advertised only when
`resolveConsumerId` is installed and the supplied ledger implements its
atomic consumer-status methods. Follow-up work adds those higher tiers; do not
place them in a manual capability override.

Install a buyer declaration after the account and its media-buy scope have
been authorized and resolved. `installConfiguration` intentionally accepts no
account, `sourceScope`, contract, timezone, currency, `constituents`, or
`mediaBuyIds` fields from the declaration. Pass the framework-resolved
`ctx.account`; trusted callbacks derive the remaining lineage. `resolveCoverage`
is the media-buy/package authorization boundary and must derive the denominator
from the resolved account: `sourceScope` may legitimately name a shared upstream
network, in which case the constituent list is the only thing keeping one
buyer's orders out of another buyer's report. `mediaBuyIds` is always derived
from the returned constituents, so a buyer-named order ID can never reach
`fetchSlice`. `expectedCurrency`, `expectedSourceTimezone`, and
`expectedMediaBuyIds` are optional assertions and fail closed on conflict.
The service rejects credential-shaped keys and `ctx_metadata` anywhere in the
returned `sourceScope`, then applies the source contract and existing ledger
immutability checks. Return the resulting secret-free configuration state from
your `sync_accounts` implementation.

For tenant-partitioned jobs, call `runCycle({ accountId })`, or configure
`start({ accountIds: [...] })`. Every planner and worker call receives that
same account boundary. A deployment-owned worker must explicitly pass
`deploymentWide: true`; use that form only when one trusted service instance is
authorized for every account in the store. Widening is reachable only through
that opt-in: a cycle with a missing, empty, or overlong `accountId` is refused
rather than silently promoted to a deployment-wide scan. Under `accountIds`,
one account's failed cycle is reported to `onError` and the remaining accounts
still run, so a persistently failing tenant cannot starve the tenants behind
it. Planning is resumable and bounded;
set `maxObligationsPerAccount` and `maxWorkerIterationsPerAccount` for tighter
operational limits. `stop()` aborts current source work, waits for settlement,
and wakes a sleeping scheduler immediately. Planning is a bounded ledger
operation rather than abortable source I/O, so shutdown waits for an in-flight
planning pass to settle and does not begin its worker afterward.

Run `runReliableReportingServiceConformanceV1` against an isolated test ledger
before deployment. It covers source replay, two-account isolation,
configuration replay/frozen currency, lifecycle start/stop, and Core
capability truthfulness.

## Advanced: assemble the primitives directly

```ts
import { Pool } from 'pg';
import {
  PostgresReportingLedgerStore,
  REPORTING_LEDGER_MIGRATION,
  sweepExpiredReportingLedgerState,
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
  type ReportingConsumerStatusLedgerStore,
} from '@adcp/sdk/reporting/ledger';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(REPORTING_LEDGER_MIGRATION);

const store = new PostgresReportingLedgerStore(pool, {
  acknowledgeIsolatedDatabase: true,
});
const producer = createReportingProducer({
  store,
  source,
  offerings,
  contact: { name: 'Reporting operations', email: 'reporting@example.invalid' },
});

const getReportingStatus = createReportingStatusHandler(store);
const getMediaBuyDelivery = createReportingDeliveryHandler(store);

// Run periodically from one or more bounded maintenance workers.
await sweepExpiredReportingLedgerState(pool);
```

Pass `getReportingStatus` and `getMediaBuyDelivery` directly to the matching `createAdcpServer` slots. The delivery helper serves only exact `reporting_revision_id` reads and returns the row payload bound by the ledger revision. Advertise `media_buy.reporting_delivery` in `experimental_features` together with a `media_buy.reporting_delivery` capability whose Reliable Reporting version is `1.0` only after both handlers are wired. Configure account resolution on the server: both handlers require the framework-resolved, caller-scoped account identity and never trust a request-body identity as an authorization boundary. If two callers can name the same upstream account, the resolver must issue distinct internal account IDs for their ledger namespaces. Install immutable delivery-configuration generations through `producer.installConfiguration`, call `planObligations()` after period close, and run `runWorker()` from a durable scheduler. Multiple workers are safe: PostgreSQL claims use `SKIP LOCKED`, expiring leases, and fencing generations.

The planner uses fixed millisecond periods and an explicitly frozen IANA source timezone. Calendar or billing-cycle schedules should be expanded by the seller into immutable period boundaries before installation; the SDK intentionally has no Temporal dependency. At period end, the obligation freezes the constituent denominator and coverage. A zero-row source object commits like any other revision. Absence remains an empty revision association. A deployment with per-tenant workers should pass the resolved `account_id` to both `planObligations()` and `runWorker()`; omitting it intentionally runs a deployment-wide worker.

### Migrating an existing manual lifecycle

Keep the same `PostgresReportingLedgerStore` and run the same
`REPORTING_LEDGER_MIGRATION`; there is no second store and no data migration.
Move each inline fetch plus its source/delivery offering into an entry in
`adapters`, move account routing and currency lookup into the two trusted
resolvers, and replace manual producer/handler/capability assembly with
`reporting.install(platform)`. Replace cron calls to `planObligations` and
`runWorker` with `runCycle` or `start`. Remove manual reporting capability
overrides so discovery has one owner. Existing configuration IDs and semantic
fingerprints remain compatible because the service delegates installation to
the existing producer: replaying a generation that predates the reserved
adapter route key reuses its stored `sourceScope` verbatim, so the fingerprint
still matches and the replay does not trip generation immutability. Only new
generations carry the reserved key. With one installed adapter, pre-service
obligations without the reserved adapter route continue through that sole
adapter. A
multi-adapter migration must create a new immutable configuration generation
with an explicit route. An adapter supplies exactly one of `fetchSlice` or
`executor`: `fetchSlice` is the inline boundary, and `executor` accepts any
`ReportingSourceWithReaderV1` — including a paginated, asynchronous, or
externally staged one — so a custom executor that needs those capabilities
runs under the service today rather than waiting for a future extension. The
inline-only knob `inlineReplayRetention` applies to `fetchSlice` adapters and
is ignored by an adapter that brings its own executor.

`reporting.install(platform)` mutates that platform object in place and
requires it to be extensible; this preserves class instances and private-field
methods that a shallow wrapper would break. It also requires the platform's
native `accounts.upsert` seam. The service cannot truthfully advertise `configuration_task:
sync_accounts` without it. That account method remains responsible for mapping
an authorized wire reporting configuration to the service's resolved input and
calling `installConfiguration`; the service does not claim a generic mapping
that the current protocol does not define.

Official configurations also pin a `finalityPolicy` (`policyId` plus `source_final` or `contractual_cutoff`). For `source_final`, set `sourceSignal` to the exact opaque signal identifier the adapter places in the manifest finality evidence's `evidenceRef`; the worker requires an exact match before irreversible official publication. `expected_at` and the wire delivery SLA use the same official deadline: the service refuses a configuration whose `officialAfterMilliseconds` disagrees with the `schedule.delivery_sla` its offering advertises, and omitting the field derives that same advertised value.

Every revision stores its rows together with an RFC 8785 JCS SHA-256 binding and exact decimal control totals for requested numeric metrics. A revision number and obligation are immutable. Official revisions are terminal; later source corrections are immutable adjustments bound to the official revision, never superseding revisions. Status snapshots omit row payloads, are capped at 8 MiB, expire after 15 minutes, and keep cursor pages stable over the flat obligation/revision/adjustment union. A periods response returns an opaque `changes_checkpoint`; echo that value verbatim as `changes_after` rather than supplying a timestamp. Account-scoped write/snapshot locks make those checkpoints gap-free for SDK store writes. The default table set is deployment-wide; use a dedicated database/schema and acknowledge that boundary explicitly. `sourceScope` must contain opaque routing identities only—never credentials or bearer tokens—because it is retained with the obligation. Retained resource locations are held to the same rule, and at the seam that persists them rather than only in the worker's pre-flight, because a caller driving `settleMaterialization` directly would otherwise store a presigned location that `get_reporting_status` then publishes. Query and fragment are refused on the raw string rather than on a successful parse, because a relative path carrying a presigning query never parsed as a URL at all; userinfo is refused as a colon-separated pair before the `@`, which is the credential shape, plus any `http(s)` userinfo at all. A blanket `@` rule would refuse `abfss://container@account.dfs.core.windows.net/...` and a Snowflake stage reference, neither of which carries a secret.

## Managed Delivery and Reconciled Billing

Core remains the default and has no destination, external-resource, or receipt dependency. To opt into the higher tiers, apply `REPORTING_MANAGED_DELIVERY_MIGRATION` **after** `REPORTING_LEDGER_MIGRATION`, explicitly construct the Core store with `managedDelivery: true`, create a `PostgresReportingManagedDeliveryStore`, and pass both stores with a destination adapter to `createReportingManagedDeliveryRuntime`. The async factory proves the stores share one authority and validates the RC3 tier wiring before returning it. It advertises `managed_delivery` only when an immutable binding, delivery, bounded resource reading, generation-fenced revocation, and at least one verification profile are installed. The advertised automated recovery window must be at least the widest installed managed Core configuration recovery window. It advertises `reconciled_billing` and `receipt_task` only when an authenticated consumer resolver and canonical-digest verification are also installed.

```ts
import {
  PostgresReportingLedgerStore,
  PostgresReportingManagedDeliveryStore,
  REPORTING_MANAGED_DELIVERY_MIGRATION,
  createReportingManagedDeliveryRuntime,
  reportingManagedDeliveryBindingV1,
} from '@adcp/sdk/reporting/ledger';

await pool.query(REPORTING_MANAGED_DELIVERY_MIGRATION);
const managedStore = new PostgresReportingManagedDeliveryStore(pool);
const managedCoreStore = new PostgresReportingLedgerStore(pool, {
  acknowledgeIsolatedDatabase: true,
  managedDelivery: true,
});
await managedStore.authorizeDestination({
  account_id: internalAccountId,
  destination_ref: destinationRef,
  generation: 1,
  authorized_at: new Date().toISOString(),
});
await managedStore.installBinding(
  reportingManagedDeliveryBindingV1({
    // Binds the Core configuration generation installed above. That
    // configuration's `schedule.recoveryWindowMilliseconds` is 3_600_000, which
    // is what `automatedRecoveryWindowSeconds: 3600` below must meet or exceed.
    ...bindingForInstalledCoreConfiguration,
    account_id: internalAccountId,
    destination_ref: destinationRef,
    authorization_generation: 1,
  })
);

type SellerContext = { account?: unknown; agent: { agent_url: string } };
const managed = await createReportingManagedDeliveryRuntime<SellerContext>({
  coreStore: managedCoreStore,
  store: managedStore,
  adapter: destinationAdapter,
  offerings: reportingDeliveryOfferings,
  resolveConsumerId: context => context.agent.agent_url,
  // MUST be at least the widest installed managed binding's Core
  // `schedule.recoveryWindowMilliseconds` / 1000 — see the precondition note below.
  automatedRecoveryWindowSeconds: 3600,
  statusRetentionDays: 90,
  resourceRetentionDays: 30,
  authorizationRevocationSeconds: 60,
});

// Supply these to the matching server slots/capability document.
const { getReportingStatus, getMediaBuyDelivery, syncReportingReceipts } = managed;
const reportingDelivery = managed.reportingDeliveryCapabilities;

// Run from a durable scheduler; replicas safely share SKIP LOCKED leases.
await managed.runWorker({ maxIterations: 100 });
```

`automated_recovery_window_seconds` is published once per agent, in one capability document, while Core `schedule.recoveryWindowMilliseconds` is per configuration. The advertised value is a **maximum** — the longest a due obligation may stay `delayed` while automated recovery continues before it becomes `action_required` — so one agent-wide number is truthful exactly when it is at least every installed window. `createReportingManagedDeliveryRuntime` enforces that bound and nothing more: advertising less than the widest installed window is refused with the offending value named, advertising more is conservative and allowed, sub-second Core windows are rounded up to the whole second the capability is expressed in, and a deployment with no managed binding — a fresh install, or one that has just offboarded its last managed tenant — starts normally. Heterogeneous tenants behind one agent therefore need no separate endpoint per cohort: advertise the widest window they run. The bound is enforced on the write path as well as at startup — `adoptAdvertisedPolicies` validates existing bindings while exclusively locking the same durable policy sentinel as `installBinding`, and `installBinding` refuses a later Core configuration whose recovery window exceeds the durable bound. `listInstalledRecoveryWindowSeconds` is optional direct-store introspection, not an authoritative publication check: an install can otherwise land between a list and a later adoption.

All four capability promises are durable and database-wide. The atomic hook adopts recovery and authorization-revocation maximums in the stronger, decreasing direction, and status and resource-retention minimums in the stronger, increasing direction. It returns those effective values so a weaker replica still runs its worker to the strongest policy already registered; PostgreSQL also enforces resource retention at settlement and authorization revocation at claim time for direct callers. A rejected binding check or policy write leaves all four columns unchanged, and a later replica can never weaken an adopted promise. Custom stores used by `createReportingManagedDeliveryRuntime` must provide the same atomic, binding-fenced contract; the optional separate recovery/status hooks remain only for compatible direct-store use and are not sufficient for capability publication. Apply `REPORTING_MANAGED_DELIVERY_MIGRATION` on upgrade as well as first install: it adds the resource-retention and revocation columns to an existing two-column registry without replacing prior promises.

Authorize a destination generation and install its immutable binding before creating any obligation for that Core configuration. Once an obligation is observable, only an exact idempotent replay of the existing binding is accepted, so the managed tier cannot appear outside the Core changes checkpoint. Build the binding with `reportingManagedDeliveryBindingV1`, which binds the exact internal account, Core configuration generation, destination authorization generation, feed purpose, method, verification profile, reconciliation mode, and resource-retention promise. That promise is a floor rather than a default at settlement: an explicit `minimum_resource_retention_days` may tighten it, never waive it, and a negative value is refused. Only a failed outcome is exempt from it — a successful one must name an expiry the database can check, or a direct store caller could persist a permanently successful materialization whose bytes no reader can fetch and which nothing revisits. It is judged only by the clock that stores the row — `assertMaterializationOutcome` deliberately does not re-check the horizon against the worker's clock, because a worker running ahead of the database then refused a resource the database considers well inside the window and reported it as `DELIVERY_FAILED`. Every claim of a pending materialization counts toward the delivery-attempt cap, and the worker calls `failExhaustedMaterializations` before planning so a row that used them all is failed rather than left pending — that sweep takes the same account lock the lifecycle apply holds, in the canonical order, because it mutates exactly the state the lifecycle compare-and-set fences and could otherwise commit `pending` -> `failed` between a matching state-version check and that apply's commit; it mutates only the accounts it locked, so a lease that expires while it waits on another account's lock is left for the next sweep rather than failed unfenced — which the planner treats as work in flight, making the revision neither claimable nor replannable. That sweep re-checks eligibility against the row it finally locked rather than only the set it selected, so a settlement that commits while the sweep waits on the row is not overwritten with `DELIVERY_ATTEMPTS_EXHAUSTED`. Revocation commits the durable deny first, fails queued work, and makes resource reads and new receipt evidence fail closed; provider-side grant cleanup is a separately leased worker action. Reauthorization uses a strictly greater generation and a new Core configuration generation. It never re-enables an old binding.

The worker claims and commits through short PostgreSQL transactions but performs destination I/O outside them. Pass `authorizationRevocationSeconds` to `runWorker()` when using a direct store; `createReportingManagedDeliveryRuntime` uses the strongest value returned by atomic adoption. PostgreSQL's claim boundary independently applies the durable minimum, so a different replica cannot widen or omit the promise: a cleanup attempt is clipped so it cannot run past `revoked_at` plus the window, a failed attempt's retry lease never outlasts the window, and a grant that has already outlived it is returned as `revocationsOverdue` for alarming. Every SLA fact — `revoked_at`, the remaining window, and whether a grant is overdue — comes from the database that committed the revocation, never the worker host, and the exact boundary counts as overdue. A crashed worker's lease is reclaimable at that boundary even before it expires, with lease generation fencing the old holder — but only once the holder has had a full attempt's worth of time, so live workers cannot steal from each other on an already-late grant and leave cleanup permanently uncommitted. `revoked_at` and `authorized_at` are both written by the committing database, never by the caller, and the strongest of the binding, caller and durable resource-retention floors is judged entirely in SQL against that clock; a settle the database refuses as under-retained is terminalized rather than left pending forever. A failed attempt gives up its lease under a short retry backoff rather than holding it for a full lease or clearing it outright — clearing it let the next iteration of the same worker tick reclaim the same grant, so one broken provider consumed every iteration — so the grant stays reclaimable and its elapsed SLA is visible rather than masked by a lease that has not expired; `claimRevocation` orders by cleanup lease generation, which the failed attempt already incremented, so releasing cannot let one broken grant starve the queue. Delivery, revocation, and resource reads have hard SDK deadlines even when an adapter ignores cancellation; resource descriptors are limited to 1 MiB and resource bodies to 64 MiB by default. Adapters must advertise `revocationFencesDeliveryGenerations: true`, make the logical `(configuration generation, revision, destination generation)` write idempotent, and install a provider-side generation tombstone before `revoke()` returns. Every delivery must be keyed by that generation and refuse a tombstoned generation, including a late provider write that completes after the SDK timed out. A successful commit requires the lease generation and unexpired lease, current authorization, exact Core row count and control totals, all evidence required by the selected verification profile, the official canonical digest when required, an immutable native version reference when applicable, and an `expires_at` satisfying the configured retention window.

`sync_reporting_receipts` derives both account and consumer from authenticated context, and `received_at` is the server's to assign: a request carrying it is refused with a typed `VALIDATION_ERROR` rather than quietly stripped, so the handler and the request schema agree on what a valid request is. RC3 caps `receipts` and `adjustment_receipts` at 100 each in JSON Schema, and bounds the batch as a whole in the request's `x-adcp-validation.batch_identity`: receipt IDs must be unique across both arrays, "whose combined length MUST NOT exceed 100". That annotation is normative prose rather than machine-checked on this path — `x-adcp-validation` is registered as an AJV keyword for commercial terms only — so the handler enforces the combined bound itself. A request that satisfies both per-array caps but exceeds 100 combined is therefore spec-invalid — and unanswerable regardless, since `results` is capped at 100 while one result per submitted receipt is required — so it is refused with a `VALIDATION_ERROR` envelope rather than an over-long `results` array. A finality filter hides managed evidence with the revision it names: returning a materialization or receipt for a revision `finality: official` omitted left the response carrying public references to a revision it does not contain. An adjustment receipt and the adjustment it names are separate pagination items, so a small `max_results` puts them on different pages; the named adjustment therefore travels with the receipt as context on whichever page carries it, and the RC3 rule that a receipt may not appear without the correction it names holds per page. Only items are counted by the cursor, so paging itself is unchanged. Its PostgreSQL implementation serializes each caller namespace, records a compact per-entry verdict for idempotency replay — receipt bodies are rehydrated from the append-only receipt table rather than duplicated — and retains those replay rows for 30 days so a consumer at the per-consumer batch cap is throttled instead of permanently locked out. An exact same-key replay is side-effect free and returns the caller its own recorded verdict even after the destination authorization is revoked. A byte-identical re-presentation of an already-recorded receipt under a fresh idempotency key likewise returns `unchanged`: both paths resolve immutable, caller-owned state and write no new evidence. Revocation governs what may be newly *accepted*, not what the caller's own stored identity answers, so no other consumer's state is read; genuinely new evidence while revoked is still refused. It exposes append-only histories only to that consumer. Revision receipts must name the exact obligation, successful materialization, current authorization, and verification evidence, and a revision whose finality satisfies the obligation's own `required_finality`, so a snapshot-finality contract reconciles on the same terms an official one does. `billing` feeds are not such a contract: RC3 requires `required_finality: official` for them unconditionally, and both `installConfiguration` and `installBinding` refuse the combination for a new generation — an immutable generation that predates the rule reinstalls unchanged, because the replay is resolved before either the offering or the validation — the binding revalidates the referenced Core configuration atomically, because a generation created before that rule existed still sits in the database — so a terminal accepted billing receipt can never land against a provisional revision. Accepted leaves are terminal; a rejected leaf may be repaired only by an exact `supersedes_reporting_receipt_id` — and a leaf whose body has been pruned still owns its subject, so the successor named by its tombstone is admitted while a fresh root carrying the same content is not. Entries that resolve to an already-stored receipt are resolved before the batch's duplicate-subject rule is applied, because such an entry writes nothing and is not competing for the subject: a batch carrying an existing rejected receipt together with its own correction records the correction rather than failing both. Duplicate receipt IDs remain a property of the whole submitted batch. A request with no receipts at all is refused with a typed `VALIDATION_ERROR` before any per-entry refusal, including a wrong-account one, because `results` has `minItems: 1` and a per-entry answer to an empty batch is an empty — schema-invalid — body. Later source corrections remain Core adjustments and receive separate append-only adjustment receipts—neither official revisions nor earlier receipts are rewritten. The per-consumer receipt cap is admission control on new rows, applied at the point one would be inserted: an exact resubmission of a receipt that already exists stores nothing, so it replays as `unchanged` at the cap rather than flipping to `failed` on the row count alone, and a refusal for capacity leaves the current leaf undemoted. Lookup failures intentionally share one generic error so the task cannot probe another account's retained objects.

The lifecycle compare-and-set covers managed state as well as Core evidence. The projection reads managed rows in their own transaction, so `getManagedLifecycleProjection` returns a `managedStateVersion` token over the obligation's materializations, receipts (including current-leaf flips), adjustments and destination-authorization state; `applyLifecycleProjection` re-reads it inside the apply transaction and refuses a stale apply. Without it a revocation, receipt or settled materialization arriving between projection and apply would be overwritten by a health computed before it existed — most visibly as a `complete` persisted and webhooked over a receipt that had just arrived. Omit `ledgerAsOf` outside a deadline sweep and the store resolves its own cutoff: a host `toISOString()` is millisecond-truncated while these columns are microsecond, so a caller-taken "now" sorts before a row written in the same millisecond and silently drops it. A pinned cutoff is also clamped to the ledger's own clock — only where there is one to clamp against; a store with no `readLedgerInstant` takes a first-attempt pin exactly as given, because `now` is precisely what pinning overrides — at the reconciler and again when the watermark is written, and a store with its own clock uses nothing but that clock on a compare-and-set retry. When a store resolves a different instant than the one it was asked for, that resolved instant is what the transition and the watermark use — the projection was computed at it, so stamping the caller's value instead watermarked a moment later than the read and buried everything in between — taking the later of the two put the caller's future pin back the moment the first attempt lost its race. A host running fast pinned an instant the database had not reached, the watermark took that instant, and every database-timestamped change inside the skew was then permanently behind it — excluded from the projection that wrote it and never due again, which left a `complete` transition and its webhook standing over a revocation that had already contradicted it. The producer's own reconciles pass their host instant as a fallback clock rather than as a pin for the same reason. Every comparison against the cutoff runs in SQL for the same reason. The projection reads and the token are taken in one `REPEATABLE READ` snapshot, so a settle committing between them cannot pair a pre-settle health with a post-settle token — the one combination the CAS would otherwise accept. A refused apply is recomputed against a **fresh** authoritative cutoff and retried immediately, bounded; the cutoff never moves backwards. The token covers materializations, receipts including current-leaf flips, adjustments, consumer statuses and destination-authorization state. The externally supplied obligated-consumer roster cannot be re-read inside the apply transaction, so it is versioned separately and re-checked immediately before the apply — every sweep refreshes a bounded slice of its managed obligations' roster versions before selecting, paging on a cursor the refresh itself advances — on failure as well as success, so a tenant whose authorization service is down yields its slot instead of occupying it every sweep, and a difference from the version last reconciled is itself a due condition. The apply fences on that observation too: it locks the obligation's lifecycle row, refuses when the published version has moved since the re-check, and never writes its own version over a newer one — otherwise a refresh landing in that window was overwritten by the version the projection had used, and since due-ness is exactly "observed differs from processed", the roster change had nothing left to re-arm from. Publishing only inside a reconcile was circular — the reconcile needs the obligation to already be due, which is what the roster change was meant to cause. Supply `version` from `obligatedConsumers`, or its resolved content is hashed for you — the projection and the re-check hash the same set, so an unversioned roster converges instead of burning its retry budget. A roster returned with `complete: true` is authoritative and excludes principals it does not list — in the lifecycle fold as well as the live projection and the digest — which is what stops a same-account principal inserting itself into the obligated set by posting a receipt. An incomplete roster is only a hint, so observed principals are still unioned in. Mutable managed state is placed at that cutoff rather than at now: `changed_at` after the cutoff means the materialization was still `pending` then, and a revocation counts only once `revoked_at` is at or before it, so a later settlement is never backdated into an earlier transition.

Managed-only changes are lifecycle candidates in their own right. A settlement, revocation, receipt, adjustment, consumer status, external-roster change or resource expiry after the last reconcile makes the obligation due, so a persisted `complete` cannot outlive a live status that has since degraded — Core deadlines alone would never reschedule it. Candidacy is measured against a per-obligation watermark in `adcp_reporting_lifecycle_state`, written on every reconcile including one that changes no health, and stamped with the cutoff the projection read at rather than the commit instant. Sweeps take that cutoff from the ledger's own clock rather than the worker host, so a fast host cannot stamp a future watermark and bury database-timestamped work committed inside the skew — anything recorded after that cutoff stays due instead of being buried by the write that follows it; without it a change with no health effect keeps the obligation due forever and, in a fair-ordered page, starves everything behind it. Sweeps reconcile each obligation in isolation, so one tenant's failing roster callback cannot abort the obligations queued after it, and a failure records an exponential backoff cursor so a page of failing tenants yields its slots instead of monopolising every sweep — including a reconcile that exhausts its compare-and-set retry budget, which is a failure rather than a completion. The backoff never advances the watermark, so the work stays visible as unresolved.

`MAX_MATERIALIZATIONS_PER_ACCOUNT` and `MAX_RECEIPTS_PER_CONSUMER` are lifetime counts by default. Because managed evidence is immutable, a long-lived account eventually reaches them and then stops planning materializations and refuses every receipt with no way back. Construct the store with `new PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays })` to make the caps active-scope: only evidence recorded inside that window counts against them, and `pruneExpiredEvidence({ account_id, limit })` deletes what has fallen outside it — never anything still inside the window, never a `pending` or leased materialization, and never a receipt batch inside its own replay retention. Retention has a floor: at least the 30-day receipt replay retention, and at least the strongest durable status or resource-retention horizon registered for the database. Adoption and binding installation exclusively lock the migration-created policy sentinel before account/binding locks; settlement, revocation claim, and pruning hold shared locks on it through their writes. A stronger promise therefore cannot land between a weaker check and its write, while unrelated hot-path readers remain concurrent. Pruning genuinely does its selection before taking the account lock, and asks which receipts a live replay row still names by expanding those rows once rather than posing a containment question per candidate — a shape no index could serve, which held the lock long enough to fail concurrent Core writes with 55P03. Because that selection is unlocked it is a proposal rather than a verdict: every victim is revalidated under the account lock against current live replay rows, surviving receipts and unexpired resources before it is deleted, so a replay that commits in the gap keeps the receipt it promised to reproduce. The revalidation is narrowed to the candidates' own consumers and keys, so the lock still holds no per-candidate scan. The registry lock is held to commit inside the transaction that acts on it, and a precondition such as the installed-window check runs inside that same transaction so a refusal rolls the write back rather than leaving a durable promise nobody validated, so an install cannot read an empty registry while a narrower promise is being registered, and a prune cannot approve a horizon another replica is about to widen. Pruning deletes and tombstones in one statement against one frozen cutoff, so a moving boundary can never leave a deleted row without its permanent identity. Successive prunes demote the tombstones they supersede, so a subject has exactly one tombstone still claiming to be its leaf and a chain pruned twice resolves the same way every time. Re-presenting a pruned receipt byte-identically answers `unchanged` with the instant the tombstone kept, resolves that receipt's own tombstone before any rule about its subject — so an exact re-presentation is not refused as new content for a settled subject — replays the same answer under the same idempotency key by rehydrating from the tombstone when the body is gone, counts as already-resolved for the batch's duplicate-subject rule, and never recreates the row: recreating it restarted the retention clock, undid the storage the prune reclaimed, and moved the published `received_at` to a moment the consumer never filed anything at. A pruned receipt ID can never bind different content, a subject whose accepted leaf expired can never reopen — the read projection consults tombstones, not just live rows — and materialization attempt history survives as a compact terminal record, so a revision that exhausted its attempts or already succeeded does not restart at attempt 1 once its rows age out. Both conclusions — the acceptance and the fact a delivery succeeded — are folded into the live, filtered and lifecycle projections alike. Counters describe exactly the records the response emits, never more and never less, so a buyer recomputing the association cannot see `ASSOCIATED_HISTORY_INCOMPLETE`; retention therefore refuses to prune an acceptance while the resource it accepts is still readable, which is what keeps a `complete` period from having nothing to show for itself. An acceptance carries the consumer that gave it, so one consumer's pruned acceptance never settles the obligation on another's behalf — including the anonymous fail-safe consumer, which owns no acceptances at all. Pruning also removes the expired replay row before the receipts it names, keeps any receipt a surviving replay row still references — a later batch can name an earlier receipt — and keeps any materialization whose resource is still readable or that a retained receipt names as its evidence. An adjustment receipt names no materialization — it names the revision it corrects — so the readable-resource hold matches on that revision as well, or a period whose revision resource was still readable lost the adjustment acceptance behind its own `complete`. Run it from the same scheduler that runs the worker. Lifecycle receipt reads are driven from the obligation's own subjects into a `(subject_id, receipt_kind, recorded_at)` index rather than asking the global receipt table which of its rows belong to an obligation — a question that supplies neither account nor consumer, so every due obligation re-scanned the whole receipt history. The managed state digest, the obligated-consumer roster read and the permanent delivery tombstones do the same — consumer statuses carry an `obligation_id` index and materialization tombstones an `(obligation_id, reached_success, reached_success_at)` one — because that digest is read inside the apply transaction while it holds the account lock: a scan there is a scan with the lock held, which pushed concurrent Core writes past their lock timeout and failed them with 55P03.

The managed tables are additive and do not alter the Core tables. This is the schema boundary coordinated with #2943: that work owns transactional reporting notification/activity intent and the existing webhook delivery/credential plane. Managed Delivery does not create a second webhook sender, outbox, credential store, or subscriber model. Apply both feature migrations after the Core migration in either order; each owns separate tables and both reuse the Core authority.

## Transactional status notifications and account activity

Production deployments can join every health or observed-finality transition to
a compact account-operator activity record. Health transitions additionally
create one durable, schema-conformant `reporting.status_changed` intent;
finality-only changes remain internal activity because the AdCP event is defined
only for health changes:

```ts
import { createPostgresPersistentNotificationRuntime } from '@adcp/sdk/server';
import {
  createPostgresReportingNotificationActivityRuntime,
  createPostgresReportingNotificationAttemptCheckpoint,
  PostgresReportingLedgerStore,
  REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION,
  REPORTING_LEDGER_MIGRATION,
} from '@adcp/sdk/reporting/ledger';

// Build the durable pre-POST checkpoint first. The notification runtime needs
// it, and the activity runtime verifies it targets the same durable store —
// a mismatched pair checkpoints nothing and loses notifications silently, so
// both are refused at construction.
const attemptCheckpoint = createPostgresReportingNotificationAttemptCheckpoint({
  db: pool,
  namespace: 'seller-production',
});
const notifications = createPostgresPersistentNotificationRuntime({
  db: pool,
  publisherScope: 'seller-production',
  checkpointDeliveryAttempt: attemptCheckpoint,
  subscriptions: { acknowledgeIsolatedDatabase: true },
  ...notificationOptions, // proof, protected credentials, webhooks, authorization
});
const reportingActivity = createPostgresReportingNotificationActivityRuntime({
  db: pool,
  notifications,
  // Use a deployment-unique value whenever a PostgreSQL schema is shared.
  namespace: 'seller-production',
  // The same checkpoint, so its store can be verified against this runtime's.
  attemptCheckpoint,
  // Pure host-owned mapping from an internal ledger account. Never derive
  // this from transition data, an incoming request body, or ctx_metadata.
  tenantScopeForAccount: accountId => durableAccountDirectory.tenantFor(accountId),
});

// Rolling-deployment order: ledger and notification tables, activity table,
// drain legacy pending transitions, then application code configured with the port.
await pool.query(REPORTING_LEDGER_MIGRATION);
for (const sql of notifications.migrations.all) await pool.query(sql);
for (const sql of reportingActivity.migrations.all) await pool.query(sql);

// Before enabling the port, keep legacy subscribers configured and run
// retryReportingStatusNotificationsV1() until listPendingTransitions() is empty.
// The transactional store fails closed if legacy pending rows remain.

// Last cutover step, only once no pre-SDK-14 writer is still serving: fence
// finality-less transitions out of the log. A surviving legacy writer now fails
// closed on append instead of silently adding another redundant finality event.
await pool.query(REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION);

const store = new PostgresReportingLedgerStore(pool, {
  acknowledgeIsolatedDatabase: true,
  notificationActivityPort: reportingActivity.port,
});

// Do not also pass legacy ReportingLedgerSubscriberV1 callbacks to lifecycle
// reconciliation. The transactional port is the sole notification handoff.

await reportingActivity.probe();
await notifications.probe();

// Run both bounded calls repeatedly from the deployment's durable scheduler.
await reportingActivity.recoverOnce({
  ownerToken: process.env.INSTANCE_ID!,
  onError: (error, claim) => operationalLogger.error({ error, claim }),
});
await notifications.recoverOnce({ ownerToken: process.env.INSTANCE_ID! });
```

`applyLifecycleProjection()` owns the transaction. After locking and rechecking
the obligation and revision evidence, the PostgreSQL store inserts the
transition, updates its issues, and calls `notificationActivityPort` with that
same transaction client. A port error rolls the whole unit back. The port does
no network I/O and stores no destination or authentication material. Only after
commit does `recoverOnce()` call the existing persistent-notification runtime,
which reads current subscriptions, enforces tenant/account matching and live
authorization, resolves opaque credential bindings, and checkpoints the normal
encrypted webhook outbox before POSTing. The activity queue is not a second
sender, credential authority, retry engine, or reporting ledger.
The store atomically stamps the transition's `notifiedAt` field as a durable
handoff marker in that same transaction. In transactional mode this field means
the activity intent is durable, not that a recipient matched or network delivery
occurred. A legacy deployment with unnotified transitions must drain or
explicitly resolve them before enabling the port; the lifecycle rejects the
cutover rather than silently abandoning those rows.

The logical notification identity is derived from the immutable transition and
is reused through ambiguous crashes. Intent insertion is exactly once;
delivery remains at least once. A crash before commit exposes neither the
transition nor its activity. A crash after commit leaves pending work. A crash
after webhook checkpointing may replay projection, but the existing webhook
delivery identity prevents rebinding. The bridge intentionally binds recipients
when the existing notification runtime checkpoints each per-subscriber webhook
delivery, not while the ledger transaction is open: that keeps subscription
credentials and destination authority out of the ledger transaction and ensures
a replacement or revocation that wins before checkpointing is honored. From
that checkpoint onward the subscriber and destination generation are stable;
the runtime rechecks live authorization on every attempt and suppresses stale
or revoked generations. Already-authorized in-flight POSTs cannot be retracted.
This explicit drain-time rule is what the replacement and revocation crash tests
assert.

Account operators can read a bounded keyset page without loading report rows:

```ts
const page = await reportingActivity.listActivity({
  tenantId: authenticatedTenant.id,
  accountId: resolvedInternalAccount.id,
  limit: 100, // 1..200
  cursor: previousPage.nextCursor,
});
```

Both scope values must come from authenticated server context. Cursors are
scope-bound and cannot be moved between accounts or tenants; the runtime also
revalidates the account-to-tenant mapping on every read. Pagination is a
newest-first operator view, not a gap-free change feed: a transaction that
commits after a page was read may have an earlier PostgreSQL sequence, so
refresh from the first page to discover concurrent late commits. Records include
the transition identity, health and observed-finality change, occurrence and
projection timestamps, issue IDs, period, and non-secret configuration/report
correlation references. They never embed revision rows, `sourceScope`,
subscriber destinations, credential handles, credentials, or `ctx_metadata`.
Each compact activity intent is capped at 64 KiB.
The runtime also applies atomic per-tenant backpressure at 100,000 pending
health notifications by default; tune `maxPendingPerTenant` to deployment
capacity and alert on the operational error instead of dropping durable intent.
This is an SDK/adopter API only: AdCP defines the complete health-notification
wire payload but no public account-activity read task, so do not expose `listActivity()`
as an invented wire extension.

Projected activity defaults to 90-day retention measured from projection (or
from commit for finality-only records that require no wire projection).
Abandoned activity is retained on the same schedule, measured from
`abandoned_at`. Override `retentionMs` only to match an explicit operator
policy, schedule bounded `pruneProjected()` calls — which reclaims projected and
abandoned rows alike — and retain pending rows until they are settled. The
reporting worker retries a failed projection up to `maxAttempts` (default 100)
and then abandons the claim; once the notification runtime has durably accepted
every matched subscriber, its own webhook outbox owns delivery retry and
retention. Supply `recoverOnce({ onError })` to report a
failed projection attempt without changing lease or retry semantics.
`matched` reports how many active subscribers were checkpointed; a projected
row with `matched: 0` is expected after revocation and does not claim network
delivery. Each recovery poll claims one row at a time so work waiting behind a
slow fanout is never left under an expiring pre-claimed lease.
The host remains responsible for a database-level retained-row/byte quota and
storage alerting per tenant or isolated deployment; the runtime's pending cap
protects delivery backlog but is not a general PostgreSQL storage quota.

### Recipient intent is frozen before any send, and revisable per recipient

The recovery worker commits its resolved recipients before anything leaves the
process, via `NotificationEvent.freezeRecipients`. The runtime then delivers
only the intersection of what is resolvable now and what was committed, so each
subscriber's `delivery_id` — and therefore the `idempotency_key` it dedupes on —
is stable across an ambiguous retry.

What makes a frozen set safely revisable is a second durable barrier:
`PersistentNotificationRuntimeOptions.checkpointDeliveryAttempt`, awaited on the
allow path of live delivery authority immediately before every external POST.
Wire `createPostgresReportingNotificationAttemptCheckpoint()` into it. It is a
runtime-level option keyed on the durable attempt context rather than a
per-emission closure because an emission snapshot cannot carry a function, so a
per-emission barrier would be skipped by the recovered outbox path — the path
where an ambiguous send is most likely.

The hook is runtime-wide, so the reporting checkpoint passes any event type it
does not own straight through. Failing closed on another subsystem's
notification would suppress every one of its attempts until the retry horizon
expired. `eventTypes` **extends** the owned set and can never shrink it —
`reporting.status_changed` is always owned, because a configuration that
silently stopped checkpointing reporting deliveries while the runtime still
advertised checkpoint support is the precise bug the checkpoint exists to
prevent.

The checkpoint is bound to the exact `(queryable, namespace, table)` it writes
to, and the activity runtime requires that same object as `attemptCheckpoint`.
It verifies in two tiers: when the port exposes `deliveryAttemptCheckpoint` —
the checkpoint it actually invokes — that must be the identical object, because
two correctly-built checkpoints can each look valid while targeting different
stores. When it does not, the declared store binding becomes mandatory and is
compared instead. Either way a mismatch is refused at construction. Configuring the two independently was
undetectable at runtime: the checkpoint's update matched no row, every attempt
was suppressed as retryable, the delivery binding eventually retired, the
recipient settled terminal and the activity projected — losing the notification
with no error anywhere.

Construction and `probe()` both fail closed unless the notification port proves
it runs the checkpoint. A custom `{ emit }` port must set
`hasDeliveryAttemptCheckpoint: true`, asserting that it forwards the event it is
handed to a runtime that does; otherwise a crash plus a destination replacement
re-addresses the notification under a second generation and idempotency key.
`acknowledgeMissingAttemptCheckpoint` exists only for tests that deliberately
demonstrate that hazard.

Declaring the capability is not sufficient, and is not trusted. Freeze and
checkpoint are one contract: a port that declares support but never calls
`freezeRecipients` leaves nothing addressable, so the checkpoint has no row to
mark and settlement would see zero outstanding recipients and record the
notification as delivered although nothing was sent. The runtime verifies that
the freeze actually ran and refuses to project the emission otherwise.

The checkpoint and a concurrent recipient replacement run as separate statements
against a pool, so neither sees the other's uncommitted work: a freeze can
propose a replacement generation while the original is being checkpointed, and
PostgreSQL keeps both rows. A partial unique index on
`(namespace, transition_id, subscriber_key) WHERE attempt_at IS NOT NULL` is the
arbiter — the second generation's checkpoint fails, so it is never POSTed, and
the next freeze drops it because its subscriber is already claimed.

Revisability is tracked **per recipient**, in `<activity_table>_recipients`:

- A recipient with no `attempt_at` provably never received a POST, because
  suppression fails closed before the checkpoint. It is replaced in place when
  it goes stale, which closes the window where a destination is replaced between
  candidate enumeration and the first POST.
- A recipient with `attempt_at` is pinned. Pinning is keyed on the **subscriber**,
  not the destination generation: once a subscriber has been addressed, a later
  generation of that subscriber is never addressed for this notification,
  because that would be one logical delivery under two idempotency keys.
- One recipient's attempt never pins a sibling. In a fanout, a subscriber
  suppressed stale before its own first POST is still re-resolved while an
  already-addressed sibling stays pinned.
- Unattempted rows are replaced rather than superseded, so a claim that retries
  many times before any send cannot accumulate rows. A settled recipient is left
  out of later emissions — it still gates projection, but re-addressing it would
  be redundant traffic.
- Settled history is compacted to one row per subscriber, and
  `maxRetainedRecipients` bounds **every retained row**. Counting only the
  addressable recipients let
  terminal rows grow for the lifetime of a claim that kept retrying while fresh
  subscribers settled.
- Every mutation — the replacement delete, the insert, compaction and
  settlement — takes a `FOR UPDATE` lock on the parent activity row before it
  touches a recipient, in a `MATERIALIZED` CTE so that lock is the statement's
  first act. Reading the lease without locking it only proved the lease was
  live when the snapshot was taken: a statement that then blocked on a
  recipient lock could resume after a successor had claimed, still see its own
  lease in the cached snapshot, and mutate the successor's rows. Holding the
  parent means a takeover cannot complete while a leaseholder's statement is in
  flight, and a statement starting after one matches nothing. Lock order is
  always parent then recipient, so the paths cannot deadlock.
- Every mutation is also gated on a live, matching lease, and so is the gate
  that authorises them. A stale worker sees an empty lease source, which makes every
  other source empty and the budget zero; gating only the row sources let that
  empty budget satisfy the check and reap the rows a successor had already
  frozen. After a takeover a stale worker is a strict no-op that refuses.
- `maxRecipients` bounds one emission's fanout and must be **at least** the
  notification runtime's `maxFanoutCandidates`. `maxRetainedRecipients` bounds
  every stored row — that fanout plus the pinned identities of subscribers
  addressed and then replaced — and defaults to twice `maxRecipients`. They are
  separate because a maximum 10,000-recipient fanout with one former subscriber
  pinned needs 10,001 rows, which a single bound capped at the fanout ceiling
  could never express. Setting either below what a notification legitimately
  needs is a misconfiguration: the claim retries until `maxAttempts` (default
  100) abandons it. An abandoned claim leaves the pending set — so it cannot
  exhaust `maxPendingPerTenant` and start refusing writes for the whole tenant —
  while staying visible as `notificationAbandonedAt` (the real abandonment
  instant) in account activity. It is never recorded as delivered.
- The bound and the replacement are one statement, and the rows it measures are
  taken `FOR UPDATE`. Measuring separately let a concurrent checkpoint turn a
  revisable row into a pinned one after the budget approved the write: the
  `DELETE` then re-checked the locked row, skipped it, and the retained set
  landed above the bound. Compaction runs before the budget, so a bound that
  compaction can satisfy never refuses, and a refusal mutates nothing — raise
  `maxRecipients` and the claim self-heals on its next pass.

| Replacement lands | Outcome |
| --- | --- |
| Before candidate enumeration | New generation enumerated and delivered |
| Between enumeration and the first POST | Suppressed `subscription_stale`, claim released, next pass replaces that recipient with the new generation; the superseded one gets nothing |
| After that recipient was checkpointed | Never re-addressed; the pinned recipient settles terminally |
| Revoked entirely | Empty recipient set is committed and the activity settles undelivered |

### Suppression is not delivery, and delivery is not settlement

Live delivery authority fails closed before every POST. Use
`notificationSuppressionDisposition(reason)` to tell the two kinds apart:

- **terminal** — `subscription_missing`, `subscription_inactive`,
  `event_not_allowed`, `authorization_denied`. The subscriber must not receive
  this event.
- **retryable** — `authorization_error`, `credential_unavailable`,
  `subscription_stale`, `attempt_checkpoint_unavailable`. Authority could not be
  established: a store read failed, an authorization or credential callback threw
  or timed out, the generation moved mid-flight, or the durable checkpoint could
  not be written. Nothing was sent (`attempts: 0`).

`subscription_stale` is the one reason whose disposition depends on the caller.
A live emission can re-resolve the new generation, so it stays retryable. A
**recovered** attempt (`WebhookEmitAttempt.recovered`) is pinned to the snapshot
it was taken from and can never become valid for a replaced generation, so it is
terminal — otherwise the outbox reclaims a dead delivery until its horizon
expires.

A delivery that throws is classified too: a retired binding or an exhausted
retry horizon surfaces as `failure.reason: 'delivery_binding_retired'` with
`terminal: true` and settles under terminal policy. Flattening it into a
retryable failure left the activity pending forever and eventually exhausted the
tenant's pending capacity.

A retryable suppression no longer terminalizes the delivery in the webhook
outbox either — it releases it, exactly as a retryable exhausted HTTP result
does, so the only durable record of the send survives for the outbox worker.

Projection requires **every** stored recipient to have reached a terminal
disposition: delivered, or deliberately not delivered. An outcome that never
reached a subscriber — a retryable suppression, a transport error, an exhausted
but retryable HTTP result — leaves the claim unsettled and the activity is not
recorded as delivered. The bundled runtime raises
`ReportingNotificationRetryableSuppressionError` for a retryable suppression.
Custom notification runtimes must implement the same barriers and the same
classification.

Intent is stored relationally, one row per recipient, keyed by a bounded 64-hex
fingerprint; only that fingerprint is indexed, so an individual recipient
reference has no length limit. `maxRecipients` defaults to 10,000 — the ceiling
the notification runtime enforces on `maxFanoutCandidates`.

Custom ledger stores implement
`ReportingLedgerNotificationActivityPortV1<TTransaction>` over their existing
authority transaction. Their `applyLifecycleProjection` equivalent must call
`recordTransition({ transition, obligation }, tx)` after its compare/lock and
before commit, and must roll back the authoritative transition if the port
fails. In the same transaction they must stamp `notifiedAt` as the durable
handoff marker. Stores must also compare `expectedPreviousFinality` with the
latest stored transition before applying a finality-only projection; this field
is optional only so pre-v14 implementations continue to compile during
migration.

That comparison must read **one** committed baseline, never a freshly
recomputed one. Transitions written from SDK 14 onward carry their own
`finality`, so the baseline is read straight back off the row. Pre-v14 rows
carry none, and their baseline is **not** reconstructed — it resolves to `none`,
which the store persists via
`resolveTransitionFinalityBaseline(reporting_obligation_id)` under its account
lock. `reconcileReportingStatusLifecycleV1` calls that port before deciding the
transition.

Stores that omit the port must also ignore `expectedPreviousFinality`, and
omitting it is **not** the same as returning `none`. The lifecycle cannot
persist a baseline on such a store's behalf, so it uses the currently observed
finality instead and the comparison becomes a no-op: finality is unobservable
there, health transitions still fire, and finality-only ones never do — exactly
the behaviour from before finality existed. Assuming `none` instead would make
every reconciliation tick observe `none -> official` and append another
finality-only transition, forever. Implement the port if you want finality-only
activity at all.

Do not try to reconstruct a historical baseline. Nothing already stored proves
which revisions had committed when a pre-v14 transition was recorded:

- **Payload timestamps** (a revision's `createdAt` against the transition's
  `occurredAt`) rank creation instants, not commits. A revision constructed
  before the transition but committed after it counts as already observed.
- **Insert wall clocks** (`recorded_at`, `created_at`, anything derived from
  `clock_timestamp()`) can repeat within a microsecond and can step backward, so
  a revision that committed after the transition can still compare equal or
  earlier. Comparing one against the transition's application-clock `occurredAt`
  additionally mixes clocks, so the store and the lifecycle decision disagree
  under skew and the compare-and-set wedges permanently.

Either rule can conclude `official`, which makes `previousFinality` equal
`finality` and silently suppresses the real snapshot→official transition and its
activity record forever. Resolving to `none` instead records at most one
redundant finality-only transition per obligation at upgrade, which stays
internal activity because the AdCP status webhook is health-only.

That bound holds only while no pre-v14 writer is still appending. During a
rolling deploy an old pod keeps writing finality-less transitions; each becomes
the latest row, gets its baseline committed as `none`, and produces another
redundant finality-only transition. Deploy ordering and wall clocks cannot rule
that out, so make it enforceable in the database.
`REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION` adds

```sql
CHECK (data ? 'finality') NOT VALID
```

to `adcp_reporting_transitions`. `NOT VALID` is the whole point: PostgreSQL
enforces the constraint for every INSERT and UPDATE while leaving historical
rows unvalidated, so existing finality-less rows keep working and new
legacy-shaped writes are rejected. Two consequences to plan for:

- **Run it last**, after legacy pending transitions are drained and no old pod
  remains. A surviving legacy writer will fail its appends with
  `rejected by the finality writer fence`. That is deliberate — a loud rejection
  beats a quietly unbounded event stream.
- **Any UPDATE must leave the row fence-clean.** The baseline resolver and
  `markTransitionNotified` both write `finality` as part of their update, so a
  historical row is repaired by the same statement that touches it.

A store that implements neither the baseline port nor the optional `finality`
fields is treated as unable to observe finality at all: the baseline becomes the
currently observed finality, so the comparison is a no-op and no finality-only
transition is ever written. Without that, every reconciliation tick would see
`none -> official` and append another one forever. Such a store behaves exactly
as it did before finality existed — health transitions still fire.

Custom stores carry the same obligation: after cutover, reject any transition
write that does not record an observed finality, and enforce it in the storage
engine rather than in application code — an application-level check does not
bind a pod running last release's binary. Repair a historical row in the same
statement that mutates it.

The transaction argument must be one BEGIN/COMMIT-bound connection, never a
pool or autocommit queryable; the per-tenant advisory transaction lock provides
capacity serialization under READ COMMITTED. Never call the port in a
post-commit subscriber callback. The bundled
PostgreSQL activity runtime accepts only the active queryable transaction and
can therefore be reused by a custom PostgreSQL ledger without adopting the SDK
ledger tables.

The transactional port and legacy `ReportingLedgerSubscriberV1` callbacks are
mutually exclusive. The bundled store exposes that mode to lifecycle
reconciliation and fails closed if both are supplied, preventing double fire;
the port's pending rows, rather than `listPendingTransitions()`, own retry.

The activity table is deliberately separate from Core revision and obligation
rows. Managed Delivery/Reconciled Billing work in #2944 can add immutable
materialization and receipt tables without changing this transition identity,
queue schema, or migration ordering.

`planObligations()` creates at most 1,000 obligations per call by default. Use its `account_id` and `maxObligations` options from a resumable scheduler when catching up dense or old schedules. Source executions are bounded to 10,000 objects, 1,000,000 rows, and 64 MiB per revision.

When `get_reporting_status` omits a period, the operational default horizon is the 24 hours ending at `ledger_as_of`. The `health` and `finality` arrays filter periods-view output only; they do not rewrite summary health or the underlying obligation projection.

`projectReportingObligationHealthV1` is the pure five-state projection. Before `expectedAt`, missing evidence is `waiting`; during recovery it is `delayed`; after the recovery deadline it is `action_required`; readable qualifying evidence is `healthy` for an open scope and `complete` for a closed scope. An unfiltered closed scope with no caller-owned configurations or no due periods is vacuously `complete`; an explicitly unknown configuration returns `lookup_unavailable`, and a snapshot with missing elapsed obligations fails closed. The simplified lifecycle persists deterministic issues and `reporting.status_changed` transitions. In legacy mode it then calls only subscribers already authorized and supplied by the host; with the transactional port, finality-only changes stay in internal activity and health changes flow through the durable AdCP notification runtime. When the store implements the optional `getManagedLifecycleProjection`, the reconciler folds Managed Delivery through the same projection the read path uses, so a persisted transition and its webhook report the health a read of that obligation would return instead of Core health alone. Every managed instant is written at database precision: a JS `Date` holds milliseconds, so taking the batch instant through one truncated `recorded_at` below the microsecond watermark written from the same clock and the reconcile it should have triggered could never become due. The lifecycle projection reads each chain's leaf **as of the cutoff** — the receipt nothing recorded by then supersedes — rather than its whole history, because the leaf is the only thing the verdict uses. Asking which row is current *now* and only then applying the cutoff answered "neither" for a rejection an acceptance had since repaired, and persisted `RECEIPT_REQUIRED` over a rejection the buyer had already filed. Reading the history instead made an obligation whose subject was repaired more times than a snapshot page may carry — a state the receipt store admits — permanently unreconcilable. A leaf also stops being a leaf when its successor is pruned — the tombstone records what it superseded — or retention handed a settled subject back to the rejection its acceptance had replaced. The read path applies the same rule at the verdict: a tombstoned acceptance outranks a rejection it superseded, so `reconciliation_status` cannot report `rejected` for a subject the lifecycle considers settled. Evidence recorded after the cutoff is out of scope at that cutoff: revisions and adjustments alike are filtered by it exactly as receipts are — a revision committed after the cutoff arrives with no materialization and no receipt in scope and would read as an unmet consumer obligation, while the compare-and-set still fences on the full revision set, which is a concurrency check rather than a statement about an instant — by the store's own ordering column, not by the producer-authored `createdAt` on the body, because a producer clock running ahead otherwise hid a committed correction from the lifecycle while the public read, which orders by that column, kept demanding a receipt for it — and pruned conclusions carry the instant they concluded, so a historical reconcile cannot settle on an acceptance or a delivery that had not happened yet. The bound is now one leaf per (consumer, subject), which is the product of two dimensions the store admits independently, and crossing it — like an oversized roster or conclusion set — truncates at a deterministic boundary and reports `receiptEvidenceComplete: false` rather than failing: a bound the write path can legitimately cross must never be a hard error, and an incomplete projection is treated exactly as an unproven roster is, so it can never report an obligation reconciled. Wire counters are computed on the read path, which still sees every row. A projection that cannot be published is reported by `runWorker` as `reconcilesDeferred` rather than aborting the sweep — the durable write already committed and the obligation stays due, so the deadline sweep, which isolates and backs off per obligation, owns the retry. Reads are scoped to one authenticated consumer while a transition is account-level, so the reconciler keeps the most severe consumer: the seller's obligation is not reconciled until every consumer that owes a receipt has accepted. Consumer-specific issue codes — `RECEIPT_REQUIRED`, `RECEIPT_REJECTED`, `ADJUSTMENT_RECEIPT_REQUIRED`, `ADJUSTMENT_RECEIPT_REJECTED` — are deliberately excluded from that persisted set and from transition `issueIds`, because the issue store is keyed by obligation with no consumer dimension and reads republish persisted issues to whichever consumer is asking; publishing them would hand one consumer another's rejection state and exact receipt ingest timing. Their severity still reaches the account-level `health`, and each caller's own issues are recomputed per read. Aggregation runs over `obligatedConsumerIds`, not over whoever happens to have submitted, so a silent authorized consumer cannot vanish when another accepts. The managed tables carry no consumer dimension on destination authorizations or bindings, so the built-in PostgreSQL store cannot prove the roster is complete and reports `obligatedConsumerRosterComplete: false`; while that is false the reconciler keeps one zero-receipt consumer in the fold and never reports a `consumer_receipt` obligation reconciled. Supply the roster from your own authorization layer through the store's `obligatedConsumers` option — `(input: { reporting_obligation_id, account_id }) => Promise<{ ids, complete }>` — and return `complete: true` to get accurate reconciled transitions. Because the conservative default holds a `consumer_receipt` obligation at `action_required` from first delivery, and the per-consumer receipt issues are deliberately not persisted, the reconciler restates that state once per obligation as a `RECEIPT_REQUIRED` issue anchored to the obligation's own `expected_at`. It names no principal and carries no receipt timing, so a degraded persisted health is never unexplained and the leak stays closed.

## Consumer status ingest

The SDK is pinned to AdCP 3.2.0-rc.4 and exposes `sync_reporting_status` from the ledger subpath. Its request, response, consumer-status, obligation, issue, delivery-capabilities, and reporting-status types come from the published rc.4 schema bundle.

```ts
const syncReportingStatus = createSyncReportingStatusHandler(store, {
  // Derive this only from authenticated transport; it is never a payload field.
  resolveConsumerId: context => context.agent.agent_url,
});

const getReportingStatus = createReportingStatusHandler(store, {
  resolveConsumerId: context => context.agent.agent_url,
});
```

Existing authoritative ledgers only need the narrow
`ReportingConsumerStatusLedgerStore` port—not the producer/worker store. An
adapter supplies `listConfigurations`, `getObligation`,
`getRevisionMetadata`, `readSnapshotPage`, `getConsumerStatusBatchReplay`, and
`syncConsumerStatusBatch`. Keep the adapter over the existing authority store:
derive the internal account and durable consumer principal from authenticated
transport, authorize before every replay or read, return immutable revision
bindings, and implement current-leaf compare + append + original batch-result
replay in one transaction. Several authorized principals for one external
account must receive separate `(internal account, consumer principal)` chain
namespaces; never create a second authority store or trust either identity from
the request body.

```ts
const statusStore: ReportingConsumerStatusLedgerStore = {
  listConfigurations: accountId => existingLedger.configurations(accountId),
  getObligation: (id, accountId) => existingLedger.obligationForAuthorizedCaller(id, accountId),
  getRevisionMetadata: (id, accountId) => existingLedger.boundRevision(id, accountId),
  readSnapshotPage: (id, accountId, cursor, limit) =>
    existingLedger.authorizedSnapshotPage(id, accountId, cursor, limit),
  getConsumerStatusBatchReplay: input => existingLedger.statusBatchReplay(input),
  syncConsumerStatusBatch: input => existingLedger.compareAppendAndReplayStatusBatch(input),
};
```

Use `reportingConsumerStatusChainKeyV1`,
`reportingConsumerStatusChainKeyFromIdentityV1`,
`reportingConsumerStatusFingerprintV1`, and
`normalizeReportingConsumerStatusIdsV1` from `@adcp/sdk/reporting/ledger` when
implementing duplicate, exact-leaf, unchanged, and replay behavior. This keeps
equivalent RFC 3339 spellings in one logical chain. `readSnapshotPage` is
optional; omitting it makes seller snapshot provenance unavailable without
blocking statuses that do not claim snapshot provenance. Store failure results
use `retryAfterSeconds` (integer seconds from 1 through 3600); invalid hints and
oversized custom codes are omitted or replaced before reaching the wire.

`sync_reporting_status` is a partial-success batch. The server validates the
closed request envelope, then the handler validates every status independently.
Custom handlers should parse each item with the exported
`ReportingConsumerStatusV1Schema` from `@adcp/sdk/reporting/ledger`; the ledger
handler already does this. The framework always applies strict envelope
validation for this task—even when general request validation is `warn` or
`off`—and rejects requests above 8 MiB, 10,000 JSON nodes, or the SDK maximum
JSON depth before dispatching either the built-in or a custom handler. Results
map one-for-one to submitted statuses in request order; inspect each `result`
even when the response envelope is `completed`. Custom handlers must also
reject every duplicate ID and every entry in a duplicate logical status chain.
`recorded_at` is seller-authored and response-only.

Clock-skew, ineligible-period, and too-early missing-status failures identify
the caller-controlled field. Obligation, revision, and snapshot mismatches are
intentionally indistinguishable so consumer status ingest cannot become an
existence oracle across retained ledger objects.

Per-item failures carry an explicit recovery classification. Schema and
authorization failures are `correctable`; an exhausted transient read slot is
`RATE_LIMITED`/`transient` with `retry_after`; oversized durable statements are
`REPORTING_STATUS_TOO_LARGE`/`correctable`; and exhausted append-only store
capacity is `REPORTING_STATUS_CAPACITY_EXHAUSTED`/`terminal`. The last two are
open-vocabulary AdCP extension codes, so clients must use their accompanying
`recovery` value rather than a closed code switch.

The language-neutral acceptance vectors ship at
`@adcp/sdk/compliance-fixtures/reporting-consumer-status-v1.json`. They pin
exact request bytes and SHA-256 digests, frozen clocks and principals, ordered
results, and post-operation ledger state so non-TypeScript adapters can run the
same contract without installing the SDK ledger as a second authority store.

The PostgreSQL store compares the exact current leaf for each consumer/configuration/report-definition/period chain in the same transaction that appends the new statement. An exact batch replay returns its original results; an identical status ID already recorded through another batch returns `unchanged`. Stale or omitted supersession fails without forking the chain. Periods readback includes only the authenticated consumer's history. A negative current statement—or a received statement naming a revision superseded by a later seller restatement—adds `CONSUMER_STATUS_MISMATCH` to that consumer's projection without changing seller-authored ledger evidence.

### rc.3 consumer-status hardening

`content_mismatch` is the fifth consumer status: the buyer consumed the exact
revision the seller requires and it contradicts a fact the accepted
configuration generation already fixed. It carries a required closed
`mismatch_code` (`scope_media_buy_missing`, `coverage_short`, `metric_missing`,
`schema_nonconformant`, `currency_mismatch`, `period_mismatch`) plus the
obligation id, the revision id, and the recomputed
`observed_revision_content_sha256`, so the disagreement names the exact bytes
that were read. It is **not** a measurement dispute — a buyer must not use it to
argue about how many impressions the seller counted; that is
`measurement_terms` / `makegood_policy` territory.

Not every conflict is an immediate escalation. A `received` statement made stale
*only* by a seller restatement projects the caller-scoped view as `delayed`
until a bounded re-read grace deadline, then `action_required`. The buyer read
exactly what the seller then required, so it gets one bounded chance to re-read
before the disagreement escalates. The deadline is the `created_at` of the
**first** revision that superseded the one the buyer named, plus the generation's
`schedule.delivery_sla` — or `automated_recovery_window_seconds` when that SLA is
zero, so a zero-SLA feed still yields a bounded window. Later restatements
supersede later revisions and therefore cannot restart it; a seller cannot hold
an unresolved mismatch below `action_required` by restating on a timer. Every
other conflict kind is `action_required` immediately.

`projectReportingConsumerStatusMismatchV1` is that projection as a pure
function, exported so a custom store can reuse the exact logic the built-in
handler runs. It returns the issue, the caller-scoped health it forces, and the
grace deadline when one applies.

Issues now carry `opened_at`, which is fixed at first emission and carried
unchanged across every re-emission — including across the `delayed` →
`action_required` transition, which reuses the same `issue_id` so consumers age
one work item instead of two. The SDK derives it from immutable ledger facts
(the first superseding revision's `created_at` for a stale read, the statement's
`recorded_at` otherwise) rather than from the read time, because advancing it on
re-emission would reset the escalation clock on every poll. Optional
`issue_state` (`open` / `acknowledged` only — a retired issue leaves the
projection instead of being published at `resolved` / `waived`) and
`external_ref` (inert correlation text, never dereferenced, never shared across
callers on a caller-scoped issue) round out the lifecycle.

Pass `consumerMismatchEscalation` to `createReportingStatusHandler` when the
capability document advertises `consumer_mismatch_escalation_seconds` and
`operations_contact` — the schema requires both or neither, so the escalation
always has a destination:

```ts
const getReportingStatus = createReportingStatusHandler(store, {
  resolveConsumerId: context => context.agent.agent_url,
  consumerMismatchEscalation: {
    escalationSeconds: 86_400,
    operationsContact: { email: 'reporting-ops@seller.example' },
  },
});
```

Advertise the same commitment in the capability document from that one value,
so the reads and the document cannot drift:

```ts
const escalation = {
  escalationSeconds: 86_400,
  operationsContact: { email: 'reporting-ops@seller.example' },
};

const reportingDelivery = {
  reliable_reporting_version: '1.0',
  consumer_status_task: 'sync_reporting_status',
  ...reportingConsumerStatusCapabilityV1(escalation), // consumer_mismatch_escalation_seconds + operations_contact
};

const getReportingStatus = createReportingStatusHandler(store, {
  resolveConsumerId,
  consumerMismatchEscalation: escalation,
});
```

Both entry points run the same validation, so a window with no destination — or
a `NaN` / negative one — fails at wiring time rather than silently never firing.
If you also apply the `health` query filter in a custom store, pass
`consumerMismatchEscalation` there too; the bundled `PostgresReportingLedgerStore`
takes it as a constructor option for exactly that reason.

Past `opened_at` plus that window an open mismatch is emitted at
`action_required` with a `contact_*` action naming the diagnosed responsible
party. `wait_for_retry` and `repair_access` are automation hints and neither
survives the boundary. The escalation boundary takes precedence over the
stale-received grace window when the two overlap. `operations_contact` is inert
display metadata for a human operator: agents surface it and MUST NOT fetch the
URL, send protocol traffic to it, or treat either value as a credential.

The summary view gains `obligation_counts.consumer_status_pending` whenever a
consumer principal is resolved (which is exactly when this handler advertises
`consumer_status_task`). It counts obligations whose consumer-status deadline —
`expected_at` plus `automated_recovery_window_seconds` — has passed with an
*empty* status chain for the authenticated caller. A chain with any unsuperseded
leaf counts as current whatever that leaf says. It is a visibility count over
the caller's own silence and never a health input: it does not change health,
any other count, or advertised reliability statistics, and it overlaps the
health counts rather than partitioning them.

Finally, `authoritative_party: 'consumer'` on a delivery configuration is
reserved for a buyer-deposited billing revision task that no released AdCP
version defines. `assertSupportedReportingAuthoritativeParty` refuses it with
`UNSUPPORTED_FEATURE`; call it from your `sync_accounts` handler on each
requested configuration, before the generation becomes ready and before any
obligation exists. `installConfiguration` already applies it. Do not coerce the
value to `seller` — that silently installs a different contract than the buyer
asked for.

Core revisions intentionally omit feed purpose, destination, obligation, and
recipient identity. Obligations sharing the same account, report definition,
period, media-buy scope, and canonical content therefore reuse one revision,
including fan-out across direct-Core and managed-materialization consumers.

For account-local calendar periods, expand each boundary externally into an
immutable configuration generation. Do not model a local day as a constant
86,400,000 ms across daylight-saving changes. For example, the New York daily
periods `2026-03-08T05:00:00Z` → `2026-03-09T04:00:00Z` and
`2026-11-01T04:00:00Z` → `2026-11-02T05:00:00Z` use 82,800,000 and 90,000,000
milliseconds respectively. Give each generated boundary its own delivery
configuration version, set `anchor` and `installedAt` to the exact start,
`supersededAt` to the exact end, and set `periodMilliseconds` to `end - start`.
The repository-only fixture at
`test/fixtures/reporting-reconciliation/consumer-status.json` contains those
23/25-hour cases,
a calendar-month boundary, and the obligation-missing path with no invented
obligation ID.
