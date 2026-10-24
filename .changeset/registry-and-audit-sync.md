---
'@adcp/sdk': patch
---

Sync the generated registry types with the published registry OpenAPI: a refused prepared-fixture request now types its `PREPARED_FIXTURES_DENIED` error body. Also patches vulnerable transitive dependencies (`body-parser`, `fast-uri`, `ip-address`, `undici`, `zod`) in the lockfile; no dependency ranges change.
