---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental, AdCP 3.3): conformance tooling.

- **Storyboard runner: `check: owed_periods_match`** (runner contract `storyboard-schema.yaml`, "Owed periods").
  - On a `get_reporting_status` periods-view step, it computes the periods a subscription owes the account from wire state alone (`get_principal` with `prior_versions` paging, `list_accounts`, `get_media_buys`, `get_adcp_capabilities`, and the response's `subscription_coverage` entry) with the SDK coverage function at `ledger_as_of`.
  - It passes when the seller's obligations are exactly that set from `ledger_retained_from`, within the request's `period`: no missing and no extra periods, the same `media_buy_ids` and `stub` flag. `pagination.has_more` fails as unverifiable.
- **Storyboard runner: brand-subject tasks.** Test-kit brand injection no longer overwrites `request_account`'s `brand`, which dropped `brand.countries` (`BRAND_SUBJECT_TASKS`).
- **`comply_test_controller` scenario `reporting_subscription_probe`.**
  - Operations: `revoke_grant`, `regrant`, `reduce_grant`, `set_account_timezone` (returns `timezone_cutovers: [{ offering_id, effective_at }]`) and `advance_time`.
  - Types: `ReportingSubscriptionProbeParams` and `ReportingSubscriptionProbeSimulated`.
  - Wiring: schema-checked params (`reportingSubscriptionProbeParamsError`), `TestControllerStore.reportingSubscriptionProbe`, `complyTest.reportingSubscriptionProbe`, and `list_scenarios` / `compliance_testing.scenarios` advertisement.
- **Test kit.**
  - Its seller implements the probe.
  - Its virtual clock may now run past the real clock: under `NODE_ENV=test` or `development`, the Reliable Reporting service hands each cycle's `now` to the inline source executor (`createInlineReportingSourceExecutor({ now })`, refused in other environments).
- **`npx adcp reporting doctor --agent <url>`** and `runReportingDoctor(client)` check a seller's subscription wiring from the wire, and name a fix for each failure.
