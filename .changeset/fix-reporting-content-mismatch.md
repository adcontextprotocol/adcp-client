---
'@adcp/sdk': patch
---

Preserve the canonical reporting consumer status contract when regenerating from protocol bundles that include `content_mismatch`. Derive ledger wire fields and status-specific validation from the pinned schema, and, when regenerated from those bundles, retain `mismatch_code` through ingest and readback and verify the consumed revision binding for content mismatches. Existing statuses remain supported; the protocol version pin and release process are unchanged.
