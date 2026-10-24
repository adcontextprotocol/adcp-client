---
'@adcp/reporting-storage': patch
---

Discover and cache the BigQuery dataset location on the first warehouse sink run when `location` is omitted. Use it for load submissions and replay job lookups so regional datasets work without an explicit location. Metadata failures stop the run before warehouse work and identify the required permission and explicit `location` option. Explicit locations continue to skip metadata access.
