---
'@adcp/sdk': minor
---

**Beta-channel break:** this SDK advertises and negotiates only the AdCP `3.3-beta.1` preview and no longer packages or advertises `3.3-beta.0`. A buyer or seller still on beta.0 (SDK 17.0.0-beta.0 through beta.4) will not select the 3.3 preview with this release; the pair negotiates a shared stable release (3.2.7, 3.1.29 or 3.0.25) instead. Upgrade both sides together to keep exercising 3.3 preview features. An explicit `adcpVersion: '3.3.0-beta.0'` pin now fails with a configuration error.

Adopt the signed AdCP 3.3.0-beta.1 bundle, replacing 3.3.0-beta.0. Public types, Zod schemas, tool metadata, skills and the packaged compliance corpus are regenerated from the beta.1 release. The SDK now advertises and negotiates the exact `3.3-beta.1` preview (full bundle version `3.3.0-beta.1`); `3.3-beta.0` is no longer advertised or packaged, so a buyer and seller must both be on beta.1 to select the preview, and otherwise negotiate a stable release (3.2.7, 3.1.29, 3.0.25 remain packaged).

New in beta.1 and available on the typed clients:

- `requestAccount()` (`request_account`, experimental `account.requests`): open an account or, with `account_id` plus fields, request a change guarded by `revision`. Resolutions include `updated`; `request_id` selects a candidate from an `ambiguous` request. Read requests back with `listAccounts({ include_requests: true })` (`account_requests[]`, paged by `requests_pagination` / `account_requests_pagination`). The unreleased `get_account_requests` task does not exist in beta.1, and `account.requests.read_task` is now `list_accounts`. `sync_accounts` stays stable.
- `reportMediaBuyIssue()` and `getMediaBuyIssue()` (`media_buy.issue_reporting`).
- `executeTask` request/response type maps, request/response validation schema maps and storyboard task mapping for all three tools. `createAdcpServer` accepts raw `accounts.requestAccount`, `mediaBuy.reportMediaBuyIssue` and `mediaBuy.getMediaBuyIssue` handlers, and the media-buy MCP tool profile matches the beta.1 manifest.

Experimental principal-level reporting subscriptions are typed (`sync_principal` / `get_principal` `reporting_subscriptions`, `get_reporting_status` `subscription_coverage`, `reporting_delivery.configuration_tasks`, `enums/reporting-dimension.json`, `principal.changed` reason `reporting_subscription_changed`, `account.authorization.authorized_at`). The built-in principal runtime rejects a submitted `reporting_subscriptions` section with `UNSUPPORTED_FEATURE` instead of silently ignoring it, and account projections now carry `authorization.authorized_at`.

Type changes to review: `DemographicTargetingIntent.age` is optional (AdCP 3.3 adds gender-only targeting), and product `publisher_properties` / `collections` rosters may be empty (`[]` means undisclosed), so do not index `[0]` unguarded. Other beta.1 additions (installments on canonical products, price adjustments, execution readiness, invoice lines, signal delivery methods and pricing groups, purchase rights, audience-evidence targets, performance-standard `metric_id`, measurement metric display names) are generated types and schemas only.

Fixes found while adopting beta.1:

- `CanonicalProposalSchema` and the targeting Zod schemas no longer fill JSON Schema defaults on parse (for example the new SLA `clock: 'elapsed'`, or `verification_required: false`). Proposals are digest-bound snapshots; a parsed proposal now keeps its original fields, and a 3.3 default can no longer leak into a response served as 3.2.
- Typed calls no longer rewrite `request_account`'s top-level `account_id` into `account`, and `request_account` / `report_media_buy_issue` get an idempotency key generated when the caller omits one (`MUTATING_TASKS`).
- The standalone commercial-terms verifier understands the 3.3 structural-bound annotations (`x-max-items-4.0` and the like) and reviews the beta.1 semantics. It fails closed on purchase `installments[]` and on business-calendar SLA windows, which need data a snapshot does not carry, and does not re-resolve `price_adjustments` tables.
- `account_request.changed` joins `CALLER_NOTIFICATION_TYPES`.
