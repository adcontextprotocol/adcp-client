---
'@adcp/sdk': minor
'@adcp/reporting-storage': patch
---

Reliable Reporting buyer reconciliation: expected periods can describe a configuration registered with `scope: { all_media_buys: true }`, where the seller freezes the buy set at `period.end`.

- `ExpectedReportingPeriod.membership` (`ExpectedReportingMembership`) is `{ kind: 'media_buy_ids' }` by default, which keeps today's exact `mediaBuyIds` and `coverage` equality, or `{ kind: 'all_media_buys', requiredMediaBuyIds? }`. An `all_media_buys` expectation omits `mediaBuyIds` and `coverage`. The obligation then has to carry valid coverage evidence whose partition equals its own `media_buy_ids`, resolved and evaluated at exactly `period.end`, and meet `coverageRequirement` (partial, none and unknown fail `full`). An empty set with full coverage matches as an explicitly evaluated zero-buy period.
- A `requiredMediaBuyIds` entry the seller omitted is a blocking per-buy issue on `ObligationReconciliation.issues` (`ReportingMembershipIssueV1`, code `REPORTING_SCOPE_MEMBER_MISSING`, `blocking: true`). The obligation still matches and is consumed for the buys it lists, but the result's `definitive` is false, and the omitted buy must never be marked reported or covered for that period.
- Type change: `ExpectedReportingPeriod` is now a union over membership, so reading `mediaBuyIds` or `coverage` from an un-narrowed value gives `string[] | undefined` and `ExpectedReportingCoverage | undefined`. Objects built with `mediaBuyIds` and `coverage` type-check unchanged. `SubscriptionExpectationTemplateV1` does not accept `membership`, because subscription obligations always carry a buyer-computed set.
- `@adcp/reporting-storage`: the GCS delivery fence refuses an `all_media_buys` expectation with `CONTENT_CONFLICT`, because it binds an exact buy set and coverage. The adapter already rejected an expectation without them, so runtime behavior is unchanged.
