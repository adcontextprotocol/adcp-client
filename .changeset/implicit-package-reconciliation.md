---
'@adcp/sdk': patch
---

Reconcile each supplied package's legacy creative format when a sync request has no assignments and every selector identifies its package. Compatible package references now share one format ID, while incompatible packages are refused with package-specific diagnostics. Mixed or unkeyed contexts retain their existing handling, and the projection preserves the request's assignment field.
