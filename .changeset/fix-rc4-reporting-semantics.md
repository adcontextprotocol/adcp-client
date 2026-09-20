---
'@adcp/sdk': patch
---

Align Reliable Reporting with the AdCP 3.2.0-rc.4 public timing and view contracts.

Complete summaries now forecast the nearest future active period start, while
open summaries and obligations use `period.end + delivery_sla`. Private source
finality cutoffs no longer replace the public due time in production, status
ingest, or buyer reconciliation. Complete periods continue to reject
`next_expected_at` without weakening complete-scope guards.

Reporting tool discovery is bound to the mounted protocol pin, and canonical
schema loading retains the selected bundled document when modular and bundled
schemas share an authored `$id`.
