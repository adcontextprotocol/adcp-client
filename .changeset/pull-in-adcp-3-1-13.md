---
'@adcp/sdk': patch
---

Upgrade the bundled AdCP protocol schemas and compliance surfaces from 3.1.11 to 3.1.13.

There are no wire-level schema changes. The refreshed compliance bundle gates the asynchronous `create_media_buy` scenario on advertised controller support and skips per-agent billing-gate phases when the seller does not advertise agent billing.
