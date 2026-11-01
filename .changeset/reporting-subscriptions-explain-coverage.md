---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental, AdCP 3.3): sellers can explain coverage, and the CLI compares traces.

- `service.explainCoverage({ principal, accountId, period, subscriptionId?, mediaBuyId?, offeringId? })` on the managed `subscriptions` path returns `CoverageTrace`s (`side: 'seller'`) from the engine's own state: the stored version history, the grant journal, the served `subscription_coverage` and the buys read under the principal. `seller_only` carries `buy_visible` and the planned obligation's `reporting_obligation_id`. Its trace of a period equals the buyer's `client.reporting.explain` trace, `inputs_digest` included.
- `@adcp/sdk/reporting/service` re-exports `coverageTraceForBuyer` and `diffCoverageTraces`.
- New CLI: `adcp reporting explain` (buyer with `--agent`, seller with `--app module#export --tenant --principal`), `adcp reporting diff left.json right.json` (names the first differing rule; exits 1 on a difference) and `adcp reporting reconcile --agent`.
