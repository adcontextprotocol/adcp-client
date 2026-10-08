---
'@adcp/sdk': minor
---

Unchanged pulses become header-only revisions. When a new revision or adjustment carries rows byte-identical to a live row set in the same obligation and binding (same chunk-manifest digest), the store records a new header that references the existing chunks instead of storing them again, and records `rows_shared_from_row_set_id`. Object-kind bindings skip the upload entirely; PostgreSQL bodies were already content-addressed. Sharing never crosses obligations, so it never crosses consumers, and every read still verifies the shared bytes against the new revision's own binding.
