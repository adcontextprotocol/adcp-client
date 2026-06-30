---
'@adcp/sdk': patch
---

Sign outbound requests that carry webhook receiver authentication even when seller request-signing capabilities are cold or do not list the operation. The verifier now also rejects unsigned requests with non-empty `authentication` objects in the payload, including task, reporting, artifact, revocation, and account notification webhook configs.
