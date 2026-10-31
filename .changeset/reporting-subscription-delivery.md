---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

Managed delivery for AdCP 3.3 subscription obligations (experimental `media_buy.reporting_subscriptions`, #3504).

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
