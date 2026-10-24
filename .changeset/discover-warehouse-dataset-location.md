---
'@adcp/reporting-storage': minor
---

Discover and cache the BigQuery dataset location on the first warehouse sink run when `location` is omitted. Use it for load submissions and replay job lookups so regional datasets work without an explicit location. Metadata failures stop the run before warehouse work and identify the required permission and explicit `location` option. Explicit locations continue to skip metadata access.

Migration: sinks that omit `location`, including US/EU datasets, now need `bigquery.datasets.get` and a client wrapper exposing `dataset.getMetadata()`. Set `location` explicitly to skip that requirement. Empty location strings are rejected; omit the option to discover it. The `ADCP_BIGQUERY_SINK_LOCATION_UNSET` warning is replaced by discovery and actionable failures. No database migration is required.
