---
'@adcp/sdk': patch
---

Stop sending BigQuery job `labels` and `jobTimeoutMs` inside a load job's `configuration.load`, where BigQuery silently dropped them (#3220). The official `@google-cloud/bigquery` client builds a local-file load's `configuration.load` from the load options and has no way to set `configuration.labels` or `configuration.jobTimeoutMs` for it, so `loadTimeoutMilliseconds` is enforced on the client and bounds a run rather than the job (see the convergence fix below). The `labels` option never reached BigQuery; it is now deprecated and emits a warning when set. Attribute load cost through `INFORMATION_SCHEMA.JOBS` by destination table or `adcp_rr_` job ID prefix. `scripts/validate-reporting-gcp.mjs` now asserts the job-field behavior (PASS/FAIL) in place of its INFO probe.
