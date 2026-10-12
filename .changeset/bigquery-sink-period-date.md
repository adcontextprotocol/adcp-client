---
'@adcp/sdk': patch
---

Fix the BigQuery warehouse sink's `period_date`. It is now the calendar date of the period start in the period's `source_timezone` (AdCP's `YYYY-MM-DD`), computed with the same helper that renders `{period_date}` in object-storage keys. The previous code fell back to the UTC date when the timezone was missing or invalid, which misdated and mis-partitioned rows of non-UTC periods. The sink now fails the batch with `Cannot compute period_date for revision <id>` instead of loading a guessed date. Rows already loaded keep their value; reload them (reset the sink or re-sync) if a non-UTC deployment loaded dates under the old fallback. `scripts/validate-reporting-gcp.mjs` gains a check that loads America/Los_Angeles, Asia/Tokyo and UTC obligations and asserts each `period_date`.
