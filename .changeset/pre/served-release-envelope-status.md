---
'@adcp/sdk': patch
---

`createAdcpServer` now validates a response with the envelope `status` of the release it serves, not the server's own release. The status was stamped at the server's release before the response was converted down, and the served release's rules applied only after validation. So a 3.2 `decline_proposals` answer carried `status: "completed"`, which the 3.2 schema forbids, and failed response validation with `VALIDATION_ERROR`. The status is now set at the served release before validation, the same way `finalize` sets it.

A submitted task also keeps `status: "submitted"` at 3.2. The 3.2 `decline_proposals` async arm (`compact-task-submitted`) requires it, but the 3.2 status removal deleted it.

Fixes #3754.
