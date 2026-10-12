---
'@adcp/sdk': patch
---

Stop sending BigQuery job `labels` and `jobTimeoutMs` inside a load job's `configuration.load`, where BigQuery silently dropped them (#3220). The official `@google-cloud/bigquery` client builds a local-file load's `configuration.load` from the load options and has no way to set `configuration.labels` or `configuration.jobTimeoutMs` for it, so the sink now enforces `loadTimeoutMilliseconds` on the client: when a load passes it, the sink cancels the job by its deterministic ID in the destination project and location, and the next run retries under a new attempt. The `labels` option never reached BigQuery; it is now deprecated and emits a warning when set. Attribute load cost through `INFORMATION_SCHEMA.JOBS` by destination table or `adcp_rr_` job ID prefix. `scripts/validate-reporting-gcp.mjs` now asserts both behaviors (PASS/FAIL) in place of its INFO probe.
