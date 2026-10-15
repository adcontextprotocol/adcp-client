---
'@adcp/sdk': patch
---

BigQuery reporting warehouse sink: warn once per process at construction when `location` is not configured. Replay lookups of load jobs need it for datasets outside the US and EU multi-regions; without it a replay returns 404, the sink uploads again, gets a 409, and raises the "check projectId and location" error. `location` stays optional. The sink runbooks also note how to upgrade from 15.9.0 (stop all 15.9.0 sink workers before starting newer ones, re-apply `REPORTING_WAREHOUSE_SINK_MIGRATION`).
