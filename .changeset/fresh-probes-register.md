---
'@adcp/sdk': patch
---

Give lazy capability probes their own operation IDs so webhook registration cannot conflict with the mutation that triggered discovery, while preserving caller cancellation, transport safeguards, webhook suppression, and delegated callback authorization.
