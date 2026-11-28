---
'@adcp/sdk': minor
---

Reliable Reporting: a configuration can request a metric the source offering declares `partial`, and a day where that metric does not apply to some media buys or packages still commits with full coverage.

Until now the producer, the service and source conformance only accepted metrics declared `exact`. A source that measured clicks, completed views or viewability for only part of its inventory had to declare them `exact`, and then one unmeasurable cell held back the whole day, including impressions and spend. This matches the Python SDK.

- A metric declared `support: 'partial'` with a `reason` is requestable alongside `exact` metrics in `installConfiguration`, the reliable reporting service and `validateReportingSourceRequestAgainstCapabilitiesV1`. A `partial` declaration without a reason, an `unavailable` metric and any non-`exact` dimension are still refused.
- In `availability_evidence`, an `unsupported` cell of such a metric is inapplicable rather than missing. Beside available cells its constituent stays `present`, takes its watermark from its measured cells, and the slice can satisfy full coverage and an authoritative close. The cell keeps its own status and reason in the manifest's metric availability.
- `delayed`, `missing` and `stale` cells still demote their constituent, so a full-coverage request still returns `PARTIAL_RESULT` while a measurement is pending. An `exact` metric's `unsupported` cell also behaves as before.
- Consumers see an inapplicable cell as absent, not zero. The constituent's rows omit the metric, a row value for an `unsupported` cell is still `INTEGRITY_FAILED`, and the revision publishes no control total for a metric that some row lacks.
- Manifest validation now allows `unsupported` cells under a `present` constituent, and refuses a constituent that has no applicable cell unless its status is `unsupported`. Source conformance refuses an `unsupported` cell of a non-`partial` metric under a `present` constituent with `MANIFEST_MISMATCH`.

Default subscription configurations still request only `exact` metrics. Request a `partial` metric through `subscriptions.configure`.
