---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental, `media_buy.reporting_subscriptions`) follow the AdCP 3.3.0-beta.4 rules. All 138 canonical coverage vectors and the new `offering-checks.json` vectors pass.

**Sellers must now emit `packages[].added_at`.** `get_media_buys` must carry `added_at` on every package added to a buy after its `confirmed_at` (adcp#8718). It is that package's own `confirmed_at`: the package is owed the periods that end after it (the period containing `added_at` is owed in full), and it resolves subscription selectors at the later of the version's `accepted_at` and `added_at`. Adding a package is never a cutover. A `package_ids` exception removes a period only when it names every package that resolves the offering and is owed the period. Without `added_at` the package reads as part of the buy at confirmation and is over-owed.

- The coverage function (`owedSubscriptionPeriodsV1`), the seller engine and the buyer runtime (`client.reporting.reconcile`, `explain`) apply the per-package rule. `ReportingSubscriptionBuyV1.packages[]` is now `ReportingSubscriptionBuyPackageV1` with optional `added_at`, the type the `subscriptions.buys` and `listAccountBuys` hooks return. The managed path reads `added_at` from the platform's `getMediaBuys`. The engine no longer records a buy revision (a cutover at the observation) for a newly listed package that carries `added_at`.
- `CoverageTrace` gains the reason `before_package_added` (rule `confirmation`). Its confirmation step lists `packages_added_at` when a resolving package was added after confirmation, and the `inputs_digest` covers a package's `added_at` only when it is present, so digests of existing buys are unchanged.
- The reference test kit serves `added_at`, and `kit.buys.addPackage(mediaBuyId, pkg)` adds a package at the kit's clock.

**Behavior change: a grant reduced without `get_reporting_status` is a loss of reporting authority** (adcp#8718). The account is listed in `accounts_unauthorized[]` with `unauthorized_at` at the reduction, coverage is withheld as for a revocation, and the service now refuses `get_reporting_status` for that account with `SCOPE_INSUFFICIENT` when the resolved account carries its reduced `authorization`. Adding `get_reporting_status` back is a re-grant (chain rule, `regranted_at`, gaps, `backfill_on_regrant`, admission). A reduction that keeps `get_reporting_status`, such as `windDownGrant`, is not a loss.

**New error code `SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY`.** A managed-delivery offering without `account_id` in `reporting_profile.primary_keys` is refused with `PlatformConfigError` code `SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY` instead of `PLATFORM_CONFIG_INVALID`. `checkReportingSubscriptionOfferingsV1(offerings, rowSchemas)` (`@adcp/sdk/reporting/advanced`) returns every offering-check failure, including the row-schema part of the rule when you supply the fetched row schema.

Coverage fixes found by the spec's differential harness: a `package_ids` exception is no longer modelled as a resolution change, so a window naming every package of a buy no longer resets a cutover's E; and an `excluded_by_buyer` entry puts only the versions whose span it overlaps under in-place membership.

The managed service dates an account timezone change at the observation, since `list_accounts` carries no change instant, instead of failing the reconcile with `SUBSCRIPTION_HOST_FACT_INVALID`.
