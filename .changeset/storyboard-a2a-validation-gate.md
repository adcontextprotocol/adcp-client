---
"@adcp/sdk": patch
---

`executeStep` now opens the validation gate when an A2A envelope is captured even if `taskResult` is undefined. Previously, storyboard steps with A2A-envelope-only validators (e.g., `a2a_submitted_artifact`) were silently skipped when the seller emitted a response that caused the A2A SDK to throw (e.g., `status.state: 'submitted'` on the transport level, which is forbidden by A2A 0.3.0). The gate condition `(taskResult || httpResult)` is expanded to `(taskResult || httpResult || a2aEnvelope)`, so validators that only need the raw wire-shape envelope run correctly against regressed sellers.
