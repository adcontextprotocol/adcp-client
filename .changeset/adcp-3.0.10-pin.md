---
'@adcp/sdk': patch
---

chore: bump AdCP pin to 3.0.10

Picks up adcontextprotocol/adcp v3.0.10 — a storyboard-only patch that converts the 12 remaining static `idempotency_key` literals across error, governance, signal, schema-validation, and creative-ad-server compliance scenarios to `$generate:uuid_v4#<alias>` form. Closes the static-key sweep for the 3.0.x line so storyboard re-runs against any spec-compliant seller no longer collide with the seller's idempotency cache after deploys.

No schema shape changes. Regen diff is metadata only (`adcp_version` strings + the entity-hydration map's source-version comment).
