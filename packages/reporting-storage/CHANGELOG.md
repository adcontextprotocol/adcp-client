# @adcp/reporting-storage

## 0.3.0-beta.6

### Minor Changes

- f6a6a76: Allow shared row-storage tables to hold rows written by another SDK without requiring its obligations in the JavaScript core ledger. The row-set obligation foreign key is removed; row-set ownership is maintained by each SDK's ledger transactions and retirement process.

  Migration: run `npx adcp-reporting-storage migrate` to apply migration 0011 to existing databases. Deployments applying the deprecated `REPORTING_ROW_STORAGE_MIGRATION` directly should reapply it. The migration drops the default `adcp_reporting_row_sets_obligation_id_fkey` constraint; remove any custom-named foreign key to the JavaScript obligations table separately. Row-set and chunk foreign keys within the shared tables remain in place.

- 36f34f6: Reporting storage (experimental): `PostgresReportingLedgerStore` records issue-lifecycle events for the SDK's `issueObserver` (#3648). This mirrors the Python storage outbox (adcp-client-python#1874).
  - **Same-transaction writes.**
    - `syncConsumerStatusBatch` records `opened` when the new leaf conflicts with the seller's record, and `resolved` for the occurrence of the leaf it superseded.
    - `commitRevision` records `opened` when a restatement makes a leaf conflict or anchors one filed before any revision. It also records `resolved` when the read projection stops conflicting.
    - Both run under the account lock the write already holds. An event exists exactly when its transition committed.
  - **Exactly-once records.**
    - An occurrence is `(issue_id, consumer_id)`, since two consumers may reuse one `reporting_status_id`. `UNIQUE (issue_id, consumer_id, kind)` keeps every record exactly once across replicas, and the `event_id` is derived from that triple.
    - `sweepIssueEscalations` settles each candidate obligation first, then records `escalated` once.
  - **Delivery.**
    - `claimIssueEvents` hands out `SKIP LOCKED` leases, at most one per occurrence, in recording order.
    - `completeIssueEvent`, `releaseIssueEvent` and `pruneIssueEvents` settle and clean up, and `issueEventsReady()` reports whether the table exists. Pruning removes only whole closed occurrences (resolved, fully delivered past the retention, and with the causing statement superseded or the obligation gone), never an open one, because the table is also the occurrence ledger and no later write may record a delivered `event_id` again.
  - **Production service.** `createPostgresReliableReportingProductionService` accepts `issueObserver` (passed to the core service it drives) and adds `REPORTING_ISSUE_EVENTS_MIGRATION` to `setup.migrations` when it is set.

  Why minor: this ships a new versioned migration that `postgresStorage().checkSchema()` requires (`REPORTING_SCHEMA_BEHIND` until applied), and per the stability policy a schema change goes in a minor of `@adcp/reporting-storage`.

  Migration note:
  1. Run `npx adcp-reporting-storage migrate`. This adds version `0012`, `reporting_issue_events`; the SQL is exported as `REPORTING_ISSUE_EVENTS_MIGRATION`. It is additive: one new table (`adcp_reporting_issue_events`) and its indexes, with no change to any existing table, key, function or trigger. It is safe to apply while workers of the previous release still run; they record no events for their own writes.
  2. Until it is applied, writes record nothing and `issueEventsReady()` is `false`, and `issueObserver` refuses to start. Nothing else changes.
  3. No storage contract moves. The Python SDK ships the same outbox as its migration `0008`, keeps its storage contract at `2`, and uses the same `event_id` derivation.

  See `docs/migration-reporting-storage-package.md` and `docs/guides/REPORTING-LEDGER.md`.

### Patch Changes

- 28694b0: Reporting storage (experimental): period retirement resolves the period's open issue occurrences (#3648 follow-up).

  `retireExpiredPeriods` deleted a period's obligation and consumer statements but left its `CONSUMER_STATUS_MISMATCH` occurrences open in the issue-event outbox. Nothing could resolve or escalate them afterwards. An occurrence that had already escalated stayed open forever: the issue observer never received its `resolved` event, and retention never pruned it.

  Retirement now records `resolved` for each of the obligation's open occurrences in the same transaction that deletes the obligation. Pending events stay deliverable: the `resolved` event carries `issue: null` and no `principal`. The whole-occurrence prune collects the occurrence once it is delivered. Outbox rows are never deleted at retirement, so no undelivered event is lost.

  No migration and no API change. `ReportingIssueEventStoreV1` (experimental) now states the contract for custom stores: a store that deletes an obligation resolves the obligation's open occurrences in the same transaction.

- Updated dependencies [f52e1ae]
- Updated dependencies [29c9af4]
- Updated dependencies [cae11b7]
- Updated dependencies [7a812a1]
- Updated dependencies [57ffd9f]
- Updated dependencies [727c947]
- Updated dependencies [daa32d9]
- Updated dependencies [c3790c8]
- Updated dependencies [8947543]
- Updated dependencies [3971edf]
- Updated dependencies [36f34f6]
- Updated dependencies [28694b0]
- Updated dependencies [8e0ec72]
- Updated dependencies [8e7fdd8]
- Updated dependencies [307c004]
  - @adcp/sdk@17.0.0-beta.22

## 0.3.0-beta.5

This release accompanies SDK `17.0.0-beta.15`; its `^17.0.0-beta.14` peer range accepts that version. SDK beta.14 was not published.

### Patch Changes

- c238cb4: BigQuery warehouse sink (experimental): the per-revision metadata load and the `current_rows` dependency on it are now part of the documented sink contract, and `revisionsTableId` is checked to be a string (#3285).

  The sink loads the rows table, then the revisions table, and `current_rows` picks each obligation's current revision from the revisions table. The TSDoc on `createBigQueryReportingWarehouseSinkV1`, `revisionsTableId`, `defaultTablesSql`, `currentRowsViewSql` and `reportingWarehouseCurrentRowsViewSqlV1`, and the BigQuery section of `docs/guides/REPORTING-LEDGER.md` and `docs/guides/REPORTING-OPERATIONS.md`, now state the load order, that the revisions table is required and must accept every column of the reference DDL, that rows can be visible before their revision metadata while `current_rows` shows only revisions whose metadata has loaded, what to query for what, and how a failed revisions load recovers (the plan is retained, the rows job is found by ID and not repeated, only the revisions job is retried, so rows are never duplicated). Tests pin the reference DDL to the metadata the sink actually loads, and assert the visibility and no-duplicate retry through the in-memory BigQuery.

  One defect fixed: the identifier check was a regular expression alone, which accepts `undefined`, so an untyped caller that omitted `revisionsTableId` was sent to a table literally named `undefined` instead of failing at construction. It now throws `BigQuery revisionsTableId is invalid`. Typed callers cannot hit this, and no valid configuration changes.

- 3645d89: Reporting storage (experimental): retirement, compaction and the write-intent sweep no longer take the per-object advisory lock, and a commit only takes it for an adopted object its own intent did not record (#3281).

  The lock (`adcp-reporting-object:{binding}:{objectRef}`) made every reference-checked delete a transaction that held a pooled connection and an advisory lock across the provider delete, and made every commit that adopted an existing object pay one lock round trip per object. Since every writable key template must include `{revision_key}`, only one row set can ever name a key, so the lock no longer ordered anything on those paths. Safety there comes from the reference check plus the fences that already existed: the account lock with the `FOR SHARE` on a header-only revision's predecessor, the `pruning` state each retirement and compaction commits before it deletes, the intent's `open` to `sweeping` transition against the commit that closes it, and version-pinned deletes. The full argument, case by case, is in `docs/guides/REPORTING-LEDGER.md` and on `deleteUnreferencedObjects`.

  Two places keep the lock, because nothing else orders them: the orphan collector's delete (its object is named by no record) and a commit that adopts an object its own write intent did not record (an earlier attempt's `PUT` landed before it was recorded). The collector now takes every binding's lock for the object in one transaction, as before. A retry that adopts an object its own intent recorded takes no lock and still proves it with the version-pinned `stat`.

  Why patch and not minor: no exported API, no schema and no wire behavior changes, and the lock key text is unchanged, so a rolling upgrade between a version that locks everywhere and this one is safe (every pair that still needs mutual exclusion keeps the lock on both sides). Nothing to migrate. The Python SDK carries the same item (adcp-client-python#1492); the exact final contract is under "Cross-SDK contract" in `docs/guides/REPORTING-LEDGER.md`.

- Updated dependencies [a1c936e]
- Updated dependencies [83d47c4]
  - @adcp/sdk@17.0.0-beta.14

## 0.3.0-beta.4

### Minor Changes

- 8c55809: Reporting storage (experimental): the orphaned-object collector is fenced against a cloned or restored ledger database (#3292).

  A clone or point-in-time restore of the ledger database shares the live database's installation identity, namespace key and configuration, so it also shares `acknowledgeExclusiveNamespace: true`. Its collector saw an older set of references and would have deleted the live database's newer row objects. A real `collectOrphanedRowObjects` pass now claims the namespace first and refuses to delete when another database holds a newer claim.
  - **Fence.** A chain of create-only objects, one per epoch, under `{prefix}/{namespace_key}/_collector-fence/`, each holding a random token. The database records its last claim in `adcp_reporting_orphan_collector_fences`. A pass deletes only while the highest epoch in the bucket is exactly the claim the database recorded; it claims the next epoch before it deletes anything and re-reads the fence before every page that deletes and every 25 deletes within one. A copy taken before the original's latest claim sees a higher epoch and refuses.
  - **Reporting.** A refused binding has `status: 'fenced'` and `fence: { cause, detail, fenceEpoch?, recordedEpoch? }`; the result has a new required `fenced: string[]`, and the maintenance task raises a warning. Causes: `fence_advanced`, `claimed_elsewhere`, `token_mismatch`, `fence_missing`, `fence_regressed`, `fence_unreadable`, `claim_lost`, `migration_required`. `dryRun` reads the fence without claiming it and reports fenced bindings too.
  - **Takeover.** New `store.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true, bindings?, includeReadOnly? })` for a database restored in place or whose predecessor is gone. It claims the next epoch and fences every other copy out; stop the previous owner's collector first, because a pass already running notices the new epoch at its next fence check (at most 25 deletes later).
  - **Limit.** Nothing in the database tells a copy from the original until one of them claims, so the first claim wins. Run orphan collection only on the live database, never on a copy of the deployment, and claim from the live database first when you roll this out. A fenced binding is checked again within the hour.

  Migration note (minor, breaking only for orphan collection):
  1. Run `npx adcp-reporting-storage migrate`: new version `0009`, `reporting_orphan_collector_fence` (additive; the SQL is exported as `REPORTING_ORPHAN_FENCE_MIGRATION`). Until it is applied, a pass reports every binding as `fenced` with cause `migration_required` and deletes nothing, and `postgresStorage().checkSchema()` names `0009` as pending.
  2. Run one real pass on the live database before any staging copy runs a collector.
  3. A custom store that implements `collectOrphanedRowObjects` for the maintenance task must return `fenced: []`. `ReportingOrphanBindingResultV1.status` gains `'fenced'`.
  4. Fence objects live in your object-store prefix. The provider contract is unchanged (create-only `putIfAbsent`, `get`, `list`, `delete`), except that `list` must now reflect keys `putIfAbsent` has already returned (read-after-write), as the bundled providers do. Run `runReportingRowObjectProviderConformanceV1` on a custom provider.

  See `docs/guides/REPORTING-OPERATIONS.md` and `docs/migration-reporting-storage-package.md`.

- 76d8a9c: Reporting storage (experimental): `row_binding_id` and `credentialRef` accept up to 255 characters, the AdCP identifier bound (#3282).

  Both were capped at 128 characters, tighter than every comparable AdCP identifier (`reporting_revision_id`, `resource_ref` and `destination_ref` use `^[A-Za-z0-9_.:-]{1,255}$`), so an adopter that derives binding IDs from AdCP destination references could be refused for no protocol reason. The configuration check, the `adcp_reporting_row_bindings` `CHECK` constraint and the keys of a provider's `clients` map now share one bound. The bound is exported as `REPORTING_ROW_BINDING_ID_MAX_LENGTH` and `REPORTING_ROW_CREDENTIAL_REF_MAX_LENGTH`, and the configuration errors say it.

  Why minor and not patch: widening what is accepted breaks nobody, but a stored `CHECK` has to change, so this ships a new versioned migration that `postgresStorage().checkSchema()` requires (`REPORTING_SCHEMA_BEHIND` until applied). Every existing deployment must run `migrate` before its application upgrades, and per the stability policy a schema change goes in a minor of `@adcp/reporting-storage`.

  Migration note:
  1. Run `npx adcp-reporting-storage migrate`: new version `0010`, `reporting_row_binding_id_bounds` (the SQL is exported as `REPORTING_ROW_BINDING_ID_BOUND_MIGRATION`). It drops the old unnamed 128-character `CHECK` and adds `adcp_reporting_row_bindings_row_binding_id_bounds` (255), only when the database still has the old one, so a current schema is untouched and nothing takes a lock. No data migration. A database that applies `REPORTING_ROW_STORAGE_MIGRATION` by hand gets the same change, and a fresh install is created with the new constraint.
  2. Until it runs, a binding ID longer than 128 characters passes the configuration check and registration fails with `STATE_UNAVAILABLE` naming `npx adcp-reporting-storage migrate (version 0010)`. Nothing that was valid before is refused.
  3. The Python SDK carries the same item (adcp-client-python#1498); keep the shared DDL equal when you upgrade both.

  See `docs/migration-reporting-storage-package.md` and `docs/guides/REPORTING-LEDGER.md`.

### Patch Changes

- Updated dependencies [d534771]
- Updated dependencies [0bf2bcc]
- Updated dependencies [047f45c]
- Updated dependencies [dd367d5]
  - @adcp/sdk@17.0.0-beta.13

## 0.3.0-beta.3

### Minor Changes

- 8374d8d: Reporting subscriptions (experimental, AdCP 3.3): buyer events.
  - `client.reporting.poll()` returns the events since the last acknowledgement, derived by comparing what the seller reports now (`reconcile`, the subscription readback, each account's `subscription_coverage[]`) with the snapshot saved by the last `batch.ack()`. Delivery is at least once with deterministic ids (`rse_` + `sha256(agent, type, natural key, version)`, the same ids as the Python SDK). A partial read never fabricates a change, and `poll({ baseline: true })` records the present without emitting it.
  - `client.reporting.events({ pollEvery, signal })` is the loop: each batch is acknowledged after the loop body has run for all its events.
  - `client.reporting.handleWebhook(verified)` treats a seller webhook as a doorbell: it wakes a running `events()` loop or polls inline. It takes only a `VerifiedWebhook`, built by `VerifiedWebhook.fromOutcome` from a successful signature verification.
  - Event types: `revision.available`, `revision.adjusted`, `period.late`, `period.missing_obligation`, `period.withheld`, `coverage.exception_opened`, `coverage.exception_closed`, `account.covered`, `account.unauthorized`, `account.regranted`, `subscription.state_changed`, `timezone.cutover`.
  - Snapshots live in a `ReportingEventStore` with compare-and-set (`ReportingEventConflictError` when another worker acknowledged first). `memoryStorage().events` and `postgresStorage({ pool }).events` provide one, `createReportingEventStore({ store })` builds one over any `AdcpStateStore` with `putIfMatch`, and the client takes it as `reportingEventStore`.
  - `@adcp/sdk/reporting/advanced` adds `deriveEvents`, `EVENT_TYPES` and `SNAPSHOT_VERSION`.

### Patch Changes

- 8856bbd: The production service refuses `subscriptions.principal` without `notifications` with a message naming the fix. `@adcp/sdk` now lets development storage omit it; PostgreSQL storage still needs a delivering runtime.
- f31e94f: Reporting subscriptions (experimental, AdCP 3.3): a PostgreSQL production seller configured with `subscriptions.principal` now serves the same principal surface as the `memoryStorage()` seller. `createPostgresReliableReportingProductionService` builds the principal runtime with the `notification_configs` task (`syncAgentNotificationConfigs`) and marks it as service-built, so the service advertises `capability_changes` for it. Before, it served neither.
- Updated dependencies [a831111]
- Updated dependencies [b296a8a]
- Updated dependencies [9cf1b55]
- Updated dependencies [6141030]
- Updated dependencies [ed8f98d]
- Updated dependencies [b5f7461]
- Updated dependencies [d134d82]
- Updated dependencies [f31e94f]
- Updated dependencies [8374d8d]
- Updated dependencies [e4b43a3]
- Updated dependencies [7cfccfd]
- Updated dependencies [1da37d9]
- Updated dependencies [dc8cad8]
- Updated dependencies [b7b9ec8]
- Updated dependencies [8856bbd]
  - @adcp/sdk@17.0.0-beta.12

## 0.3.0-beta.2

### Minor Changes

- eeeb370: Reporting subscriptions (experimental `media_buy.reporting_subscriptions`): the coverage function, engine, principal runtime, ledger and managed delivery follow the AdCP 3.3.0-beta.3 rules. All 120 canonical coverage vectors pass.
  - **Flights and cancellation (adcp#8617, #8618).** A buy's stop time uses `cancellation_effective_at`, the delivery stop under a cancellation, when present. Flight values at each period's end come from the buy's wire `flight_history`. **Breaking:** the non-wire `prior_flights` coverage input and `ReportingSubscriptionPriorFlightV1` are removed. Pass `flight_history` (`ReportingSubscriptionFlightHistoryEntryV1`) from `get_media_buys` instead.
  - **Billing stubs (adcp#8617).** A cutover onto a billing feed whose schedule has no boundary at E owes `[E, first boundary)` as one stub period. Owed rows, grouped obligations, ledger obligations and the wire `reporting_obligation` carry `stub: true`.
  - **Re-grants (adcp#8618).** The grant journal serves `authorization.regranted_at` on `list_accounts` and `sync_accounts` for a chain that continued past a loss of authority. **Breaking:**
    - `engine.observeGrants` now returns `{ authorized_at, regranted_at? }` per account.
    - The host account fact's `granted_at` is renamed `regranted_at`, the wire name.
  - **Sticky resolution (adcp#8619).** Each package resolves once per (buy, version), at the later of `accepted_at` and `confirmed_at`, among the offerings available then. It keeps that resolution until the offering is withdrawn. New: `resolveReportingSubscriptionPackageV1`. The managed path reads each package's `reporting_delivery_offering_ids` snapshot from `get_media_buys`.
  - **Admission (adcp#8619).** Under `max_accounts`, admission is sticky and ordered by `authorized_at`, then `account_id`. Accounts with another open exception keep their place. A deactivation releases its slots.
  - **Membership in place (adcp#8619).** Adding or removing `account_ids`, or changing `exclude_account_ids`, keeps the version. The engine records each edit per account as an `excluded_by_buyer` interval. Changing the scope kind or `operator_domains` still needs a new version, and `client.reporting.subscribe` auto-versions accordingly.
  - **Several feeds per purpose (adcp#8619).**
    - Pacing and analytics allow several subscriptions per account and purpose. Where two resolve one offering for a package, the lower `subscription_id` owes it, and the other records a package-level `overridden` exception.
    - Billing stays one per account at a scope level, and must use `match: exact` with `dimensions`.
  - **`destination_overrides` (adcp#8619).**
    - Each override is validated.
    - The readback carries `destination_override_refs`.
    - Managed delivery binds each account to its routed destination and template. New: `reportingSubscriptionDestinationForAccount`, plus `ReliableReportingSubscriptionBindingInputV1.destination`.
  - **Paged readback (adcp#8619).**
    - Lists of any length are kept.
    - The response lists 1,000 accounts inline, each list with its total.
    - `get_principal` `reporting_subscription_page` pages `accounts_with_exceptions`, `accounts_unauthorized` and `prior_versions`.
    - `onReadbackOverflow` and `readback_overflow` are deprecated and never report.
  - **Partial grants (adcp#8619).** With subscriptions, `sync_reporting_status` (SDK service) and `sync_reporting_receipts` (`@adcp/reporting-storage` service) refuse a task that the account's `authorization.allowed_tasks` leaves out with `SCOPE_INSUFFICIENT`. New: `assertReportingTaskGrantedV1`.
  - **Delivered rows (adcp#8619).** Creating a service with subscriptions refuses a managed-delivery offering whose `reporting_profile.primary_keys` omit `account_id`.
  - **Period arithmetic (adcp#8622).**
    - Each local date's first instant is always a boundary of a sub-daily local schedule, so `PT24H` equals `P1D` where midnight doesn't exist.
    - Reactivation resumes at the later of the reactivation instant and the end of the last period owed before the deactivation.
  - **Account requests (adcp#8620).** `accounts.ensure` outcomes carry the request's `resolution`, `effective_at` and `not_carried_over`. The account's money terms are on `account`.

- ff2feb6: Managed delivery for AdCP 3.3 subscription obligations (experimental `media_buy.reporting_subscriptions`, #3504).
  - `reportingSubscriptions.bindManagedGeneration` binds a managed subscription generation to its destination before the generation's first obligation is written. The planner calls it through `planSubscriptionObligations({ bindGeneration })`. A rejection writes nothing, and the next cycle tries again. A subscription that resolves a managed offering without a binding composition fails to plan.
  - Every row of a subscription revision carries `account_id`. It is stamped before the revision is bound, and a row naming another account is refused. Account revisions are unchanged.
  - `ReportingLedgerSubscriberV1.principal` scopes status subscribers: a subscription obligation's transitions reach only its owning principal.
  - The engine gains `isAuthorized(principal, accountId)`, and `frozenOwedSets` versions carry the frozen `destination_method`. `withReportingSubscriptionCoverageV1` is exported for compositions.
  - `@adcp/reporting-storage`:
    - `createPostgresReliableReportingProductionService` delivers managed subscription obligations. Pass the principal runtime as `reportingSubscriptions.principal`; the engine must have `isAuthorized`.
    - `createReportingSubscriptionManagedBindingV1` resolves the owner's current destination generation, authorizes it per account (`ensureDestinationAuthorization`), and installs a binding that freezes the version's `path_template`.
    - The managed worker passes the expanded `delivery_path` to adapters. It re-checks the owner's account authority before delivering and before settling, and releases a lost claim with `holdMaterialization` without failing it. Reads are scoped with `resolveSubscriptionPrincipal`.
    - `REPORTING_MANAGED_DELIVERY_MIGRATION` drops the three-column `adcp_reporting_managed_bindings` key, found by its columns, so bindings are keyed by their Core configuration. It is additive and idempotent.
    - `reportingObjectWriteName` takes an optional delivery path that sits inside the generation prefix, and `isReportingObjectWriteName` recognizes it. The GCS adapter writes there, and status reads scope to the owner.
    - Notification activity for a subscription obligation is fanned out only to its owning principal.

- d942a1f: Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the low-level building blocks move to a new `@adcp/sdk/reporting/advanced` subpath, tagged `@experimental`.
  - `@adcp/sdk/reporting/advanced` exports the coverage engine (`createReportingSubscriptionEngineV1`) and its stores (`createInMemoryReportingSubscriptionEngineStoreV1`, `createReportingSubscriptionEngineStateStoreV1`), the coverage function (`expectedSubscriptionPeriods`, `groupExpectedSubscriptionPeriodsV1`, `reportingSubscriptionCoverageGrantedV1`), the period calendar, offering selection, the capability builder (`reportingConfigurationCapabilitiesV1`), the consumer bridge (`reportingSubscriptionVersionRecordsV1`, `subscriptionExpectedReportingPeriodsV1`), and the service's subscription hooks (`ReliableReportingSubscriptionsOptionsV1` and its input types, `withReportingSubscriptionCoverageV1`).
  - `@adcp/sdk/reporting/service`, `/consumer` and `/ledger` no longer re-export them. Change the import path; the symbols are unchanged. The `reportingSubscriptions` option on `createReliableReportingService` is unchanged.
  - `@adcp/reporting-storage` imports `withReportingSubscriptionCoverageV1` and `ReliableReportingSubscriptionBindingInputV1` from the new subpath, so it needs an `@adcp/sdk` that has it.

- 18a1c0e: Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the managed seller path.
  - `createReliableReportingService({ subscriptions: SubscriptionOptions })` enables the feature without assembling the engine by hand. The service:
    - builds the coverage engine;
    - installs the `reporting_subscriptions` section on the principal runtime (`subscriptions.principals`, created without `reportingSubscriptions`);
    - fills in `capabilities.principal` in `install()`;
    - reconciles a principal after each `sync_principal` write that submits subscriptions (`reconcileOnWrite`, on by default);
    - sweeps every subscribed principal at the start of each `runCycle`.
  - **Derived inputs.** The roster comes from the platform's `accounts.list` and the buys from `sales.getMediaBuys`, read under the principal's identity. `accounts`, `buys`, `buyOfferings`, `accountDeliveryConfigs`, `endAccountConfigs`, `isPeriodDelivered` and `resolvePrincipal` override them. `configure` is required.
  - **Failures.** A roster that can't be read is a `PlatformConfigError` coded `SUBSCRIPTION_ROSTER_UNAVAILABLE`. Reconcile and planning failures are returned in `runCycle`'s `subscriptionPlanningFailures` and passed to `planningErrorHandler`; they are never thrown as an `AggregateError`.
  - **Options.** The names follow the Python SDK's `SubscriptionOptions`. The advanced block with your own `engine` still works, as before.
  - **Principal runtime.** The runtime gains `installReportingSubscriptions` (internal) and `PrincipalReportingSubscriptionSupport.onApplied`. Its `capabilities` reflects a section installed later.
  - **Service.** `service.subscriptionWiring` exposes the resolved wiring to compositions.
  - **`@adcp/reporting-storage`.** The production service accepts the managed block.

- 1e7a5c3: Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): names frozen before beta.3. Every old name stays as a deprecated alias for one beta.
  - `PrincipalRef { tenantId, principalId }` (package root, `@adcp/sdk/server`, `/reporting/advanced`, `/reporting/ledger`) is the one principal identity type. `PrincipalStoreScope` and `ReportingLedgerSubscriptionPrincipalV1` are deprecated aliases.
  - "Owed" is the one word for what a seller must deliver (`@adcp/sdk/reporting/advanced`):
    - `expectedSubscriptionPeriods` → `owedSubscriptionPeriodsV1`, which also gains the `V1` suffix the module's other low-level symbols carry;
    - `groupExpectedSubscriptionPeriodsV1` → `groupOwedSubscriptionPeriodsV1`;
    - `ExpectedSubscriptionPeriodV1`, `ExpectedSubscriptionObligationV1` and `ExpectedSubscriptionPeriodsInputV1` → `OwedSubscriptionPeriodV1`, `OwedSubscriptionObligationV1` and `OwedSubscriptionPeriodsInputV1`;
    - `subscriptionExpectedReportingPeriodsV1` → `toExpectedReportingPeriodsV1`, which keeps "expected" because it feeds the consumer's `ExpectedReportingPeriod`.
  - The principal runtime's `recordReportingSubscriptionCoverage` → `recordSubscriptionReadback`, because it writes readback lists, not `subscription_coverage`. The engine's `listPrincipals` → `listSubscriptionPrincipals`, which matches the service hook it feeds.
  - `createReliableReportingService({ subscriptions })` and `createPostgresReliableReportingProductionService({ subscriptions })` replace `reportingSubscriptions`, which stays as a deprecated alias. Passing both is a `PlatformConfigError`.

- f8368e7: Reporting storage facade (experimental, AdCP 3.3): one storage decision covers the reporting ledger, `sync_principal` principal records, the reporting-subscription engine state and the buyer consumer's checkpoints and leases.
  - **`@adcp/sdk/storage`** (new subpath): `memoryStorage()` returns a process-local `ReportingStorage` (ledger, `principals`, `subscriptions`, `consumer`, `checkSchema()`, `close()`). It is refused outside `NODE_ENV=test|development` with `REPORTING_STORAGE_NOT_DURABLE`. Also exports `developmentEnvironment`, `requireDurable`, `isReportingStorage` and `DEVELOPMENT_ENVIRONMENTS`.
  - **`postgresStorage({ pool })`** in `@adcp/reporting-storage`: the durable storage over one pool. Its `checkSchema()` refuses a schema that is behind with `REPORTING_SCHEMA_BEHIND`, naming the pending versions and the command to run.
  - **Versioned migrations** in `@adcp/reporting-storage`: `migrations()`, `migrate(pool)`, `migrationStatus`, `pendingMigrations` and the `npx adcp-reporting-storage migrate [--status | --dry-run]` command. Versions are recorded in `adcp_schema_migrations`, the table the Python SDK uses. A schema set up by hand from the old constants migrates cleanly. `REPORTING_LEDGER_MIGRATION`, `REPORTING_MANAGED_DELIVERY_MIGRATION` and the other constants the migrations cover are deprecated re-exports for one beta.
  - **`createReliableReportingService({ storage })`** takes the storage instead of `store`, and passing both is refused. The first cycle runs `checkSchema()`. With the managed `subscriptions` block, engine state defaults to `storage.subscriptions`. `subscriptions.principals` is now optional: pass `subscriptions.principal` (the principal runtime's options) and the service builds the runtime over `storage.principals`, exposed as `service.principals`. `createPostgresReliableReportingProductionService({ storage })` accepts the same storage instead of `db`, and `createReliableReportingConsumerV1({ storage })` uses `storage.consumer` as its persistence.
  - **Durability is intrinsic.** `AdcpStateStore` declares `durability` (`InMemoryStateStore` is process-local, `PostgresStateStore` is durable). The `durability` option of `createPrincipalStateStore` and `createReportingSubscriptionEngineStateStoreV1` is deprecated: a value that agrees with the store is ignored, and one that contradicts it is refused.

- a74b552: The reporting ledger now holds subscription obligations for AdCP 3.3 principal-level reporting subscriptions (experimental `media_buy.reporting_subscriptions`, #3504).
  - `producer.planSubscriptionObligations({ account_id, principal, subscriptionId, configurations, obligations, owedThrough })` writes one subscription's frozen owed set into the ledger.
    - It installs one generation per (account, owning principal, subscription_id, subscription_version, resolved offering). The generation's `delivery_config_id` is the `subscription_id` and its `delivery_config_version` is the `subscription_version`. A changed generation throws `ReportingConfigurationImmutableError`.
    - Each obligation carries its own period, `media_buy_ids` frozen at its `scope_resolved_at` (the period end) and constituents. Its `periodOrdinal` is the period start in whole seconds. Periods are never grid-filled.
    - It then advances the mutable `owedSet.through` horizon on every generation the subscription owns on the account.
  - Subscription generations carry an immutable `subscription` block (`tenantId`, `principalId`, `subscriptionId`, `offeringId`, `ownership: 'owed_set'`) and a mutable `owedSet`. Account generations keep exactly their previous ids and fingerprints.
  - Completeness of an owed-set generation is its `owedSet.through` horizon, not ordinal counting. A gap is a period that is not owed, so it never raises a continuity error. A scope whose end is past the horizon reports `scope_closed: false` and keeps `coverage_complete: true`.
  - Caller isolation: `get_reporting_status`, `get_media_buy_delivery` and `sync_reporting_status` take `resolveSubscriptionPrincipal`. A caller sees account generations plus only its own subscription generations and obligations, and nothing of another principal's. Without it no subscription generation is visible. Snapshot queries carry `subscription_principal`.
  - Subscription obligations emit `offering_id` to callers served AdCP 3.3. `sync_reporting_status` accepts a status without `reporting_obligation_id` against a subscription generation only when it names an existing owed obligation.
  - `ReportingLedgerStore` gains optional `recordOwedSetProgress` and `findObligationByOrdinal` methods. A store must implement `recordOwedSetProgress` to hold subscription generations.
  - `@adcp/reporting-storage`: `REPORTING_LEDGER_MIGRATION` adds `adcp_reporting_configurations.subscription_key` (empty for account generations). It replaces the three-column generation constraint with a unique index on `(account_id, delivery_config_id, delivery_config_version, subscription_key)`. The migration is additive and idempotent, and existing rows keep their uniqueness. `PostgresReportingLedgerStore` implements the new methods and applies `subscription_principal` to every snapshot.

- 331d732: Owner-scoped receipts and statuses, and grant-aware coverage, for AdCP 3.3 reporting subscriptions (experimental `media_buy.reporting_subscriptions`, #3504).
  - **Owner-only receipts and statuses.** A subscription obligation accepts `sync_reporting_receipts` and `sync_reporting_status` only from its owning principal. Account obligations stay open to every consumer of the account. `reportingSubscriptionReceiptAdmissibleV1` is the single rule.
    - `createSyncReportingReceiptsHandler` takes `{ resolveSubscriptionPrincipal }` and passes an `admission` to stores that declare `receiptAdmission`.
    - `PostgresReportingManagedDeliveryStore` enforces it, and a refused receipt reads exactly like an unknown reference.
    - The production service wires it from `reportingSubscriptions.resolvePrincipal`.
  - **No post-revocation window.** This follows the owner's decision, ahead of the 3.3.0-beta.3 spec text; beta.2 still describes the old window. Once authority for an account ends, every task treats the account as unknown, receipts and statuses included. A seller that wants a buyer to finish reconciling keeps a reduced grant instead, for example `allowed_tasks` limited to `get_reporting_status`, `sync_reporting_receipts` and `sync_reporting_status`.
  - **Coverage follows the grant.** `ReportingSubscriptionAccountFactV1.allowed_tasks` carries the grant's `authorization.allowed_tasks`. The engine covers an account only while that list includes `get_reporting_status`; `reportingSubscriptionCoverageGrantedV1` holds the rule, and a grant with no task restriction counts as all tasks. Dropping `get_reporting_status` from the grant is a loss of authority for coverage at that instant, with an `accounts_unauthorized` entry. The same applies to an `authorizationChanged` push.
  - **Subscriptions off.** Nothing changes.

### Patch Changes

- e1b1fd3: Reporting subscriptions docs (AdCP 3.3, experimental):
  - A README section.
  - The seller and buyer guides (`docs/guides/REPORTING-SUBSCRIPTIONS-SELLER.md`, `REPORTING-SUBSCRIPTIONS-BUYER.md`), with titles and sections matching the Python SDK.
  - A `reporting-subscriptions` skill with do/don't anti-patterns.
  - The reporting guides and the `@adcp/reporting-storage` README now show `postgresStorage({ pool })` and `npx adcp-reporting-storage migrate` instead of the migration constants.

  The generated `Agent` / `AgentCollection` `syncPrincipal` and `ADCPMultiAgentClient.syncPrincipal` TSDoc now start "Replaces each submitted section. To add a reporting subscription, use `client.reporting.subscribe`."

- Updated dependencies [aa6f26c]
- Updated dependencies [6fef3b8]
- Updated dependencies [ff77a2d]
- Updated dependencies [eeeb370]
- Updated dependencies [5e35609]
- Updated dependencies [9d917bc]
- Updated dependencies [3dcbf64]
- Updated dependencies [ff2feb6]
- Updated dependencies [201e6dc]
- Updated dependencies [d942a1f]
- Updated dependencies [989e83b]
- Updated dependencies [e1b1fd3]
- Updated dependencies [edff7a7]
- Updated dependencies [8997e1d]
- Updated dependencies [ebb6cc7]
- Updated dependencies [18a1c0e]
- Updated dependencies [1e7a5c3]
- Updated dependencies [ed8ed37]
- Updated dependencies [f8368e7]
- Updated dependencies [3428a00]
- Updated dependencies [209ded8]
- Updated dependencies [a74b552]
- Updated dependencies [331d732]
- Updated dependencies [b6d741d]
- Updated dependencies [4084b81]
- Updated dependencies [00b957a]
  - @adcp/sdk@17.0.0-beta.11

## 0.3.0-beta.1

### Minor Changes

- 14a83dd: Support trusted-host reporting history before a configuration was installed (#3453). Pass `historyStart` in the service install context (or producer install options), and call `extendConfigurationHistory({ configurationId, historyStart })` to move ownership earlier without a new configuration generation. Source retention, schedule alignment, historical calendar compatibility, and generation overlap are validated. Coverage and consumer status include historical ownership while installedAt, fingerprints and existing publications stay unchanged.

  Live planning and execution take priority over history. `maxHistorySlicesPerSource` defaults to 10 claims per source offering per worker pass; `maxHistoryObligationsPerSource` optionally bounds history planning. Zero pauses either history operation. Budgets are local to each pass; hosts and adapters still coordinate shared upstream quotas. Backfill retries have a durable private recovery window from the first execution attempt without changing public period-based deadlines.

  Migration: upgrade the SDK and storage package together and reapply `REPORTING_LEDGER_MIGRATION` before starting the new workers. It adds the nullable `adcp_reporting_configurations.history_start` audit column and live-priority claim indexes idempotently; existing configurations keep their original ownership. Do not grant or extend history until all workers are upgraded. Custom stores opting into history must persist the history boundary and ordinal, implement atomic monotonic extension and generation-overlap checks at both install and extension, and honor live-first claims and `excludeHistoryOfferingIds`. See the reporting ledger guide for the API and pacing contract.

### Patch Changes

- b4682cb: Address SDK 17 adoption feedback (#3460): preserve the media-buy lifecycle for 3.0 buyers; include collection/proposal account notification types; validate account-change drains at the negotiated release; retain compatible legacy format pairings when a sibling option cannot be mapped; expose shared AssetVariant and targeting key arrays; generate exclusive daypart clock forms and nonempty Zod output types; and shorten unavailable-version diagnostics.

  Document all added union/enum members, vendor-metric planning behavior, and pnpm peer convergence in `docs/migration-16-to-17.md`. Release reporting-storage alongside this SDK beta, with `@adcp/reporting-storage@0.3.0-beta.1` requiring SDK `^17.0.0-beta.2`. Install both beta tags together with `--save-exact`; stable storage 0.2.0 continues to require SDK 16. No storage migrations change in this fix.

  Zod validation now enforces protocol-authored `minItems` throughout, including render-guidance positions, and preserves nonempty array output types as `[T, ...T[]]`. Empty arrays previously accepted contrary to the schema now fail validation.

- Updated dependencies [7700d50]
- Updated dependencies [ca0bf28]
- Updated dependencies [64d7970]
- Updated dependencies [7dd3b86]
- Updated dependencies [dc54bf8]
- Updated dependencies [64d7970]
- Updated dependencies [21fed85]
- Updated dependencies [b6538e5]
- Updated dependencies [f49c85c]
- Updated dependencies [b4682cb]
- Updated dependencies [5c16f99]
- Updated dependencies [dad64c2]
- Updated dependencies [9f9da45]
- Updated dependencies [14a83dd]
- Updated dependencies [b4682cb]
- Updated dependencies [b4682cb]
- Updated dependencies [bd09edd]
  - @adcp/sdk@17.0.0-beta.2

## 0.2.1-beta.0

### Patch Changes

- Updated dependencies [505ddc9]
- Updated dependencies [8a04f48]
- Updated dependencies [8a04f48]
  - @adcp/sdk@17.0.0-beta.0

## 0.2.0

### Minor Changes

- eaaa07f: Discover and cache the BigQuery dataset location on the first warehouse sink run when `location` is omitted. Use it for load submissions and replay job lookups so regional datasets work without an explicit location. Metadata failures stop the run before warehouse work and identify the required permission and explicit `location` option. Explicit locations continue to skip metadata access.

  Migration: sinks that omit `location`, including US/EU datasets, now need `bigquery.datasets.get` and a client wrapper exposing `dataset.getMetadata()`. Set `location` explicitly to skip that requirement. Empty location strings are rejected; omit the option to discover it. The `ADCP_BIGQUERY_SINK_LOCATION_UNSET` warning is replaced by discovery and actionable failures. No database migration is required.

### Patch Changes

- Updated dependencies [eaaa07f]
- Updated dependencies [47934c6]
- Updated dependencies [5a0a03f]
- Updated dependencies [a31d162]
- Updated dependencies [e678796]
- Updated dependencies [ba711f1]
- Updated dependencies [acddab4]
- Updated dependencies [4f5d366]
- Updated dependencies [7dca440]
- Updated dependencies [7dca440]
- Updated dependencies [7d272f9]
- Updated dependencies [6c281d9]
- Updated dependencies [a008b4e]
- Updated dependencies [7f7de7c]
- Updated dependencies [3d53212]
- Updated dependencies [1dcd427]
- Updated dependencies [7b181ff]
- Updated dependencies [8c97223]
- Updated dependencies [80cec20]
  - @adcp/sdk@16.5.0

## 0.1.0

### Minor Changes

- 4a79162: Reliable Reporting: the account change feed now orders by `(xid, seq)` behind `xid < pg_snapshot_xmin(pg_current_snapshot())`, as the deployment-wide feed already did (#3283). The feed no longer depends on the account lock to keep `seq` in commit order, and the in-flight truncation guard from #3228 is gone. A change with a lower `seq` and a higher `xid` that commits late is returned on a later page, after the cursor, instead of being skipped. This is an `@experimental` surface, so the break ships as a minor.

  **Migration note.**
  - Re-apply `REPORTING_LEDGER_CHANGES_MIGRATION` before starting the new binary. It is idempotent. It adds `pruned_through_xid` and `pruned_through_xid_seq` to `adcp_reporting_change_account_horizon`, replaces the `adcp_reporting_feed_consumers` check constraint (an account consumer may now carry an `xid`, and a pre-upgrade account row keeps a NULL one), creates the `adcp_reporting_changes_account_xid (account_id, xid, seq)` index, and takes an advisory lock so concurrent appliers cannot race. The old `adcp_reporting_changes_account (account_id, seq)` index is left in place; drop it once no older host runs.
  - On a large changes table, create the index first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS adcp_reporting_changes_account_xid ON adcp_reporting_changes (account_id, xid, seq)`; a plain `CREATE INDEX` in the migration blocks appends while it builds.
  - Stop the older hosts' change-feed maintenance (`pruneChanges`, `retireExpiredPeriods`, compaction) before the new binary reads an account feed. The older code holds an account consumer's changes by `seq` alone and records only `pruned_through_seq`, so it could prune a change a new-format cursor has not read without advancing the horizon the new reader checks. Rolling back after a consumer saved a new-format account cursor is not supported: the older SDK rejects it, so reset those consumers.
  - Account cursors now carry `xid` (`{ v, account, seq, xid }`). Consumers store the cursor string opaquely and need no change.
  - An account cursor saved before the upgrade (`seq` only) is accepted. `changesAfter` maps it to `(xid, seq)` with `xid` the smaller of the oldest `xid` among the account's changes after that `seq` and the reading snapshot's `xmin`. Every later change has an `xid` at or above both, so none is skipped. Changes the consumer already read can be returned again (those with a lower `seq` and a higher `xid`, and, if a long transaction was open at that moment, every change committed since it began), so consumers must treat redelivery as normal. The returned cursor is in the new format. A legacy cursor fails closed with `CURSOR_EXPIRED` (resynchronize from `listCurrentRevisions`) if any change with a higher `seq` was pruned. A consumer registration saved before the upgrade holds retention by `seq` until its next `saveFeedConsumerCursor`.
  - `pruneChanges` (which now selects victims in `(xid, seq)` order), `retireExpiredPeriods` and snapshot compaction now hold a change for an account consumer until the consumer has passed it in `(xid, seq)` order. BigQuery sinks need no change: their saved account cursor is upgraded on the next batch.
  - Any older open transaction on the cluster now holds the account feed back, as it already held the deployment feed. An empty page means caught up or held back.

- 01cd708: Initial release of `@adcp/reporting-storage`: the Reliable Reporting storage implementations, split out of `@adcp/sdk` (adcp-client#3286) so they release on their own version line.

  It holds `PostgresReportingLedgerStore` and its migrations, row storage (PostgreSQL and object kinds, the provider contract, the conformance suite and the filesystem provider), object writes, the host change feed and ledger maintenance (`@adcp/reporting-storage`); the managed-delivery runtime, store and adapter router (`/managed`); notification activity (`/notifications`); `createPostgresReliableReportingProductionService` (`/service`); the GCS, S3 and Azure providers (`/gcs`, `/s3`, `/azure`); and the BigQuery warehouse sink (`/bigquery`). `reportingLedgerMaintenance` builds the `maintenance` option of `createReliableReportingService` for a PostgreSQL ledger.

  `@adcp/sdk` (`^16.0.0-beta.0`) is a peer dependency, so the host holds one copy of the protocol layer. `@aws-sdk/client-s3`, `@azure/storage-blob` and `@google-cloud/storage` are optional peers. The package ships CommonJS and ESM builds with declarations for both.

  The package starts at `0.0.0` so this changeset sets its first version: under pre-release mode it publishes as `0.1.0-beta.0` on the `beta` dist-tag. It is pre-1.0 on purpose: every export is `@experimental`, breaking changes ship in minor releases with a migration note, and the first stable release is `1.0.0` once the surface has run at a production adopter (`docs/guides/REPORTING-STABILITY.md`). Pin it with `~`.

  Moving from `@adcp/sdk/reporting/*`? See `docs/migration-reporting-storage-package.md` for the import mapping.

- 062bfd0: Reliable Reporting: add an opt-in listing collector for row objects the write-intent sweep cannot see (#3284). It covers an upload whose `PUT` succeeded before the intent recorded it, intents for a binding no running host configures, and intents lost to a database restore.
  - `PostgresReportingLedgerStore.collectOrphanedRowObjects` lists each configured object binding under `{prefix}/{namespace_key}/` and deletes an object only when its key is a `.jsonl` or `.jsonl.gz` row object under that prefix, it is older than `minAgeSeconds` (default 7 days, minimum 1 day), no row set that is not yet `pruned` has a chunk at the key and no write intent lists it, and, under the per-object advisory lock and exact-version reference check that every other delete takes (`deleteUnreferencedObjects`), nothing live references that version. `readOnly` bindings are skipped unless `includeReadOnly`; `dryRun` reports `candidates` and deletes nothing; `limit` bounds objects examined per binding per pass and `cursors` resume the listing.
  - Enable it in the scheduler with `orphanCollection: { enabled: true, acknowledgeExclusiveNamespace: true, ... }` on the production service, or `reportingLedgerMaintenance({ orphanCollection })` as the `maintenance` option of the Core-only service. Deleting requires `acknowledgeExclusiveNamespace: true` (a dry run does not). `intervalSeconds` (default one day) spaces full listings; a listing that does not finish within `limit` continues on the next pass. The task is named `orphan object collection`, reports listed, referenced, too young, foreign, deleted and failed counts, and warns about failed bindings and bindings whose provider cannot list. Its position (`orphanState`) is kept in the process, so a restart begins a new listing. `ReportingLedgerMaintenanceTaskNameV1` and the task result union gain `'orphan object collection'`, so an exhaustive `switch` over task names stops compiling until it handles it.
  - References are checked under every binding, because two bindings can share a bucket and prefix. Entries a provider returns that are not row-object keys under the owned prefix, or have no strict RFC 3339 write time, are never touched. A listing that fails on the first page of a resumed cursor restarts from the beginning instead of wedging, and a provider that repeats a page token or returns more than a page is failed rather than looped on.
  - `ReportingRowObjectProviderV1` gains an optional `list({ prefix, pageToken, pageSize })` returning each stored version under a prefix with its native version, size and write time. The filesystem, GCS, S3 and Azure Blob providers implement it (on versioned stores it lists noncurrent versions too and never delete markers), and `runReportingRowObjectProviderConformanceV1` checks it when present and then reports a `list` entry in its result. A custom provider without `list` keeps working; its binding is reported as unsupported by the collector.
  - Migration note: the conformance result gains a `list` entry for providers that implement `list`, so code that compares the whole array must expect it. Enable the collector only on the ledger database that owns the namespace; a clone or restore of that database pointed at the same bucket shares its namespace key and would delete the objects of row sets the original wrote after the copy. Start with `dryRun: true`. See `docs/guides/REPORTING-OPERATIONS.md`.

### Patch Changes

- Updated dependencies [9be4bc0]
- Updated dependencies [b6e98e2]
- Updated dependencies [e8e2b32]
- Updated dependencies [5b1d06c]
- Updated dependencies [67c6f1e]
- Updated dependencies [5282446]
- Updated dependencies [eb763e2]
- Updated dependencies [6485148]
- Updated dependencies [af1cda5]
- Updated dependencies [7c7f730]
- Updated dependencies [44305aa]
- Updated dependencies [01c2522]
- Updated dependencies [613aa77]
- Updated dependencies [01c2522]
- Updated dependencies [1159cd0]
- Updated dependencies [6152eeb]
- Updated dependencies [d450b7d]
- Updated dependencies [22fe878]
- Updated dependencies [f8bd48c]
- Updated dependencies [61360e4]
- Updated dependencies [ed6eefd]
- Updated dependencies [6f491ef]
- Updated dependencies [b7d1156]
- Updated dependencies [8946228]
- Updated dependencies [6129906]
- Updated dependencies [2a0fa78]
- Updated dependencies [b928628]
- Updated dependencies [2a0fa78]
- Updated dependencies [6326b54]
- Updated dependencies [7599c4d]
- Updated dependencies [90efe10]
- Updated dependencies [656022f]
- Updated dependencies [8cb06d2]
- Updated dependencies [75a6943]
- Updated dependencies [217d113]
- Updated dependencies [bb3ed66]
- Updated dependencies [55feb1c]
- Updated dependencies [11f3913]
- Updated dependencies [9a23e5b]
- Updated dependencies [1ecb660]
- Updated dependencies [d6fe8b1]
- Updated dependencies [bdaf068]
- Updated dependencies [a2b62ac]
- Updated dependencies [18ad969]
- Updated dependencies [cfa5173]
- Updated dependencies [10fac80]
- Updated dependencies [ba8151d]
- Updated dependencies [d24f791]
- Updated dependencies [cf9803b]
- Updated dependencies [61360e4]
- Updated dependencies [12f2660]
- Updated dependencies [5a7d2b4]
- Updated dependencies [891ed2d]
- Updated dependencies [aba77ed]
- Updated dependencies [01cd708]
- Updated dependencies [5b1d06c]
- Updated dependencies [28ced9e]
- Updated dependencies [dfc9c4b]
- Updated dependencies [daf93e7]
- Updated dependencies [83741da]
- Updated dependencies [cf9803b]
- Updated dependencies [32f89ff]
- Updated dependencies [e4eb640]
- Updated dependencies [7caa852]
- Updated dependencies [017160c]
  - @adcp/sdk@16.0.0

## 0.1.0-beta.0

### Minor Changes

- 4a79162: Reliable Reporting: the account change feed now orders by `(xid, seq)` behind `xid < pg_snapshot_xmin(pg_current_snapshot())`, as the deployment-wide feed already did (#3283). The feed no longer depends on the account lock to keep `seq` in commit order, and the in-flight truncation guard from #3228 is gone. A change with a lower `seq` and a higher `xid` that commits late is returned on a later page, after the cursor, instead of being skipped. This is an `@experimental` surface, so the break ships as a minor.

  **Migration note.**
  - Re-apply `REPORTING_LEDGER_CHANGES_MIGRATION` before starting the new binary. It is idempotent. It adds `pruned_through_xid` and `pruned_through_xid_seq` to `adcp_reporting_change_account_horizon`, replaces the `adcp_reporting_feed_consumers` check constraint (an account consumer may now carry an `xid`, and a pre-upgrade account row keeps a NULL one), creates the `adcp_reporting_changes_account_xid (account_id, xid, seq)` index, and takes an advisory lock so concurrent appliers cannot race. The old `adcp_reporting_changes_account (account_id, seq)` index is left in place; drop it once no older host runs.
  - On a large changes table, create the index first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS adcp_reporting_changes_account_xid ON adcp_reporting_changes (account_id, xid, seq)`; a plain `CREATE INDEX` in the migration blocks appends while it builds.
  - Stop the older hosts' change-feed maintenance (`pruneChanges`, `retireExpiredPeriods`, compaction) before the new binary reads an account feed. The older code holds an account consumer's changes by `seq` alone and records only `pruned_through_seq`, so it could prune a change a new-format cursor has not read without advancing the horizon the new reader checks. Rolling back after a consumer saved a new-format account cursor is not supported: the older SDK rejects it, so reset those consumers.
  - Account cursors now carry `xid` (`{ v, account, seq, xid }`). Consumers store the cursor string opaquely and need no change.
  - An account cursor saved before the upgrade (`seq` only) is accepted. `changesAfter` maps it to `(xid, seq)` with `xid` the smaller of the oldest `xid` among the account's changes after that `seq` and the reading snapshot's `xmin`. Every later change has an `xid` at or above both, so none is skipped. Changes the consumer already read can be returned again (those with a lower `seq` and a higher `xid`, and, if a long transaction was open at that moment, every change committed since it began), so consumers must treat redelivery as normal. The returned cursor is in the new format. A legacy cursor fails closed with `CURSOR_EXPIRED` (resynchronize from `listCurrentRevisions`) if any change with a higher `seq` was pruned. A consumer registration saved before the upgrade holds retention by `seq` until its next `saveFeedConsumerCursor`.
  - `pruneChanges` (which now selects victims in `(xid, seq)` order), `retireExpiredPeriods` and snapshot compaction now hold a change for an account consumer until the consumer has passed it in `(xid, seq)` order. BigQuery sinks need no change: their saved account cursor is upgraded on the next batch.
  - Any older open transaction on the cluster now holds the account feed back, as it already held the deployment feed. An empty page means caught up or held back.

- 01cd708: Initial release of `@adcp/reporting-storage`: the Reliable Reporting storage implementations, split out of `@adcp/sdk` (adcp-client#3286) so they release on their own version line.

  It holds `PostgresReportingLedgerStore` and its migrations, row storage (PostgreSQL and object kinds, the provider contract, the conformance suite and the filesystem provider), object writes, the host change feed and ledger maintenance (`@adcp/reporting-storage`); the managed-delivery runtime, store and adapter router (`/managed`); notification activity (`/notifications`); `createPostgresReliableReportingProductionService` (`/service`); the GCS, S3 and Azure providers (`/gcs`, `/s3`, `/azure`); and the BigQuery warehouse sink (`/bigquery`). `reportingLedgerMaintenance` builds the `maintenance` option of `createReliableReportingService` for a PostgreSQL ledger.

  `@adcp/sdk` (`^16.0.0-beta.0`) is a peer dependency, so the host holds one copy of the protocol layer. `@aws-sdk/client-s3`, `@azure/storage-blob` and `@google-cloud/storage` are optional peers. The package ships CommonJS and ESM builds with declarations for both.

  The package starts at `0.0.0` so this changeset sets its first version: under pre-release mode it publishes as `0.1.0-beta.0` on the `beta` dist-tag. It is pre-1.0 on purpose: every export is `@experimental`, breaking changes ship in minor releases with a migration note, and the first stable release is `1.0.0` once the surface has run at a production adopter (`docs/guides/REPORTING-STABILITY.md`). Pin it with `~`.

  Moving from `@adcp/sdk/reporting/*`? See `docs/migration-reporting-storage-package.md` for the import mapping.

- 062bfd0: Reliable Reporting: add an opt-in listing collector for row objects the write-intent sweep cannot see (#3284). It covers an upload whose `PUT` succeeded before the intent recorded it, intents for a binding no running host configures, and intents lost to a database restore.
  - `PostgresReportingLedgerStore.collectOrphanedRowObjects` lists each configured object binding under `{prefix}/{namespace_key}/` and deletes an object only when its key is a `.jsonl` or `.jsonl.gz` row object under that prefix, it is older than `minAgeSeconds` (default 7 days, minimum 1 day), no row set that is not yet `pruned` has a chunk at the key and no write intent lists it, and, under the per-object advisory lock and exact-version reference check that every other delete takes (`deleteUnreferencedObjects`), nothing live references that version. `readOnly` bindings are skipped unless `includeReadOnly`; `dryRun` reports `candidates` and deletes nothing; `limit` bounds objects examined per binding per pass and `cursors` resume the listing.
  - Enable it in the scheduler with `orphanCollection: { enabled: true, acknowledgeExclusiveNamespace: true, ... }` on the production service, or `reportingLedgerMaintenance({ orphanCollection })` as the `maintenance` option of the Core-only service. Deleting requires `acknowledgeExclusiveNamespace: true` (a dry run does not). `intervalSeconds` (default one day) spaces full listings; a listing that does not finish within `limit` continues on the next pass. The task is named `orphan object collection`, reports listed, referenced, too young, foreign, deleted and failed counts, and warns about failed bindings and bindings whose provider cannot list. Its position (`orphanState`) is kept in the process, so a restart begins a new listing. `ReportingLedgerMaintenanceTaskNameV1` and the task result union gain `'orphan object collection'`, so an exhaustive `switch` over task names stops compiling until it handles it.
  - References are checked under every binding, because two bindings can share a bucket and prefix. Entries a provider returns that are not row-object keys under the owned prefix, or have no strict RFC 3339 write time, are never touched. A listing that fails on the first page of a resumed cursor restarts from the beginning instead of wedging, and a provider that repeats a page token or returns more than a page is failed rather than looped on.
  - `ReportingRowObjectProviderV1` gains an optional `list({ prefix, pageToken, pageSize })` returning each stored version under a prefix with its native version, size and write time. The filesystem, GCS, S3 and Azure Blob providers implement it (on versioned stores it lists noncurrent versions too and never delete markers), and `runReportingRowObjectProviderConformanceV1` checks it when present and then reports a `list` entry in its result. A custom provider without `list` keeps working; its binding is reported as unsupported by the collector.
  - Migration note: the conformance result gains a `list` entry for providers that implement `list`, so code that compares the whole array must expect it. Enable the collector only on the ledger database that owns the namespace; a clone or restore of that database pointed at the same bucket shares its namespace key and would delete the objects of row sets the original wrote after the copy. Start with `dryRun: true`. See `docs/guides/REPORTING-OPERATIONS.md`.

### Patch Changes

- Updated dependencies [2a0fa78]
- Updated dependencies [2a0fa78]
- Updated dependencies [bdaf068]
- Updated dependencies [891ed2d]
- Updated dependencies [01cd708]
- Updated dependencies [daf93e7]
- Updated dependencies [e4eb640]
  - @adcp/sdk@16.0.0-beta.4
