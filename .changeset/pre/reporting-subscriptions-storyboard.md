---
'@adcp/sdk': minor
---

Add a reporting-subscriptions conformance storyboard and a reference seller that passes it (experimental `media_buy.reporting_subscriptions`, AdCP 3.3). `examples/storyboards/reporting-subscriptions.yaml` checks capability discovery, a dry run, the applied lifecycle with readback and idempotent replay, rejections, versioning with `prior_versions`, `get_reporting_status` `subscription_coverage`, and deactivation by omission. `examples/reporting-subscriptions-seller/seller.mjs` composes the principal runtime, the coverage engine and the Reliable Reporting service behind `createAdcpServerFromPlatform`. Owed periods, grant changes and the `delivery_config_id` clash are not covered: the runner cannot move the seller's clock, change a grant or seed an account-level configuration.
