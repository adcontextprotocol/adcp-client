---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the managed seller path.

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
