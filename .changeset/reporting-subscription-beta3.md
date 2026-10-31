---
'@adcp/sdk': minor
---

**Beta-channel break:** this SDK advertises and negotiates only the AdCP `3.3-beta.3` preview and no longer packages or advertises `3.3-beta.2`. A buyer or seller still on beta.2 (SDK 17.0.0-beta.10) will not select the 3.3 preview with this release; the pair negotiates a shared stable release (3.2.7, 3.1.31 or 3.0.25) instead. Upgrade both sides together to keep exercising 3.3 preview features. An explicit `adcpVersion: '3.3.0-beta.2'` pin now fails with a configuration error.

Adopt the signed AdCP 3.3.0-beta.3 bundle, replacing 3.3.0-beta.2. Public types, Zod schemas, tool metadata and the packaged compliance corpus are regenerated from the beta.3 release.

- Every 3.3 task response composes the protocol envelope (adcp#8547): `status` is required on every response, and the generated response types no longer restate envelope fields.
- Account requests (adcp#8620): resolved `matched`/`created` records carry `account` with its money terms, an `updated` money change carries `effective_at`, and a change that `created` a separate account carries `not_carried_over`.
- Experimental live creative updates: `creative.live_updates` types, `CREATIVE_LIVE_UPDATE_UNSUPPORTED`, and the `creative.staged_update_changed` notification type, which joins `ACCOUNT_NOTIFICATION_TYPES`.
- Reporting subscriptions: `authorization.regranted_at` joins the account authorization fields (`toWireAccount` and `windDownGrant` keep it); media buys carry `cancellation_effective_at` and `flight_history`, packages `reporting_delivery_offering_ids`, offerings `available_from`/`withdrawn_at`, billing obligations `stub`, and `subscription_coverage[].status` is served as `inactive` with `deactivated_at`. Readbacks list at most 16 `prior_versions` and carry `prior_versions_count`, `accounts_with_exceptions_count` and `accounts_unauthorized_count`. A subscription response served without a negotiated release uses the pinned release, as in the Python SDK.

**Removed from `@adcp/sdk/reporting/advanced`:** the hand-modelled wire types `ReportingDeliveryOfferingWithDimensionsV1`, `ReportingSubscriptionCoverageWithOfferingsV1`, `ReportingSubscriptionExclusionEntryV1`, `ReportingSubscriptionGapV1`, `ReportingSubscriptionInactiveIntervalV1`, `ReportingSubscriptionStateWithIntervalsV1` and `ReportingSubscriptionTimezoneCutoverV1`. The generated `ReportingDeliveryOffering`, `ReportingSubscriptionCoverage` and `ReportingSubscriptionState` carry every field; `ReportingSubscriptionOfferingV1` is now an alias of `ReportingDeliveryOffering`.

Codegen follows the beta.3 envelope layout: the `request_proposals`, `refine_proposals` and `decline_proposals` submitted arms keep `status: 'submitted'` and the required `task_id` (folded from `core/task-submitted.json`), and generated Zod response schemas keep the `adcp_version`, `adcp_major_version`, `task_id` and `message` constraints they inherit through the composed envelopes.
