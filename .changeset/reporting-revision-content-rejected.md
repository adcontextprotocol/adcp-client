---
'@adcp/sdk': minor
---

Buyers can now tell a seller that a reporting revision's content was rejected, instead of reporting a transport failure.

`reconcileReporting` posts any error thrown by `client.getMediaBuyDelivery` as `unreadable` / `transport_failed`. A consumer that validates the rows before accepting them, for example refusing rows outside the revision's coverage, therefore told the seller the transport failed. Throw the new `ReportingRevisionContentRejectedError` from the read instead, with `integrity_mismatch` (the revision contradicts what the seller declared for it) or `reader_incompatible` (your reader cannot accept it), and the SDK posts `unreadable` with that `failure_code`.

Only the code goes on the wire. The error's optional `reason` stays in the local `plan.reason`, bounded and stripped of control characters, and its `message` and `cause` are never read. `isReportingRevisionContentRejectedError` recognizes the error across the CommonJS and ESM builds. Every other thrown error, including one that only looks like this class, is still `transport_failed`, so existing consumers see no change.
