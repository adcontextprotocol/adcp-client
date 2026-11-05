---
'@adcp/sdk': minor
---

**Beta-channel break:** this SDK advertises and negotiates only the AdCP `3.3-beta.4` preview and no longer packages or advertises `3.3-beta.3`. A buyer or seller still on beta.3 will not select the 3.3 preview with this release; the pair negotiates a shared stable release (3.2.8, 3.1.31 or 3.0.25) instead. Upgrade both sides together to keep exercising 3.3 preview features. An explicit `adcpVersion: '3.3.0-beta.3'` pin now fails with a configuration error.

Adopt the signed AdCP 3.3.0-beta.4 bundle (spec commit 763c2d75, sha256 3525423d..., cosign-verified), replacing 3.3.0-beta.3. Public types, Zod schemas, tool metadata and the packaged compliance corpus are regenerated from the beta.4 release.

- **Fixed `destination_overrides` type.** `ReportingSubscription.destination_overrides[]` is now one object type with `account_ids`, `operator_domains`, `destination_id` and `path_template` (the item schema is one `if`/`then`/`else`). Beta.3 generated `({} & ({} | {}) & ({} | {}))[]`, which accepted any object and named no field.
- **Packages:** `get_media_buys` `packages[].added_at` (see the reporting-subscription changeset for what sellers must emit).
- **Schema-enforced durations:** `reporting-schedule` and `reporting-schedule-offering` reject a `period_duration` that mixes date and time components (`P1DT12H`) under `account_timezone`, `source_timezone` or `billing_cycle`; `utc` still accepts it.
- **Compliance:** `comply-test-controller` request and response schemas specify `reset_state` and `SetAccountTimezoneResult`; the reporting-subscription storyboards check `reset_state` and the reduced-grant rule.
- Other beta.4 schema additions are carried as generated: `BUDGET_TOO_LOW` details gain `budget_field`, `basis`, `constraint` and `related_field`; explicit-package `create_media_buy` requests accept `opportunity`.
- The canonical reporting-subscription vectors are pinned to v3.3.0-beta.4.
