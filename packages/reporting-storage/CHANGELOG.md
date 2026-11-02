# @adcp/reporting-storage

## 0.3.0-beta.3

### Patch Changes

- 8856bbd: The production service refuses `subscriptions.principal` without `notifications` with a message naming the fix. `@adcp/sdk` now lets development storage omit it; PostgreSQL storage still needs a delivering runtime.
- Updated dependencies [9cf1b55]
- Updated dependencies [6141030]
- Updated dependencies [ed8f98d]
- Updated dependencies [e4b43a3]
- Updated dependencies [7cfccfd]
- Updated dependencies [dc8cad8]
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
