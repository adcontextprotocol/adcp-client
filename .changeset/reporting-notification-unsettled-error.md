---
'@adcp/reporting-storage': patch
---

Reporting notification recovery now reports an outstanding recipient as a typed, expected retry, and reports abandonment separately, so a host can stop alerting on every retry.

- **`ReportingNotificationUnsettledError`** replaces the plain `Error` that `recoverOnce({ onError })` received when an emission returned with a recipient still outstanding (a 5xx, a 429, a transport error, a timeout or an emitter failure). The message is unchanged ("Reporting notification delivery is not settled for N recipient(s); retrying") except on the final attempt, where it ends "attempt N of M, not retrying". The error carries `transitionId`, `unsettled`, `attempt`, `maxAttempts` and up to ten `recipients`, each with its scope, `subscriberId`, `destinationGeneration`, a `reason` (`delivery_failed`, `delivery_runtime_error` or `retryable_suppression`) and `finalStatus` when the last attempt got an HTTP response. It never carries a URL or credential. The production service's scheduler `onError` receives the error without the claim, so these fields are how a host finds the subscriber that is not accepting deliveries. A retryable suppression on the first outstanding recipient still raises `ReportingNotificationRetryableSuppressionError`.
- **`ReportingNotificationAbandonedError`** is reported to the same `onError` after a claim reaches `maxAttempts` and is abandoned: it left the pending set, will not be retried and was never recorded as delivered. `cause` is the final attempt's failure, which `onError` has already received. Hosts that alert on `onError` get one extra call per abandoned claim.

The retry and abandonment behaviour itself is unchanged. The canonical wiring in `docs/guides/REPORTING-LEDGER.md` now logs the expected retry at `warn`.
