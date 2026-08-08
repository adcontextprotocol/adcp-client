---
'@adcp/sdk': patch
---

Fix `testCreativeSync()` fixture to be schema-valid: add `asset_type: 'image'` discriminator on `assets.primary`, preserve `agent_url` in the string-format fallback path via object spread, and add `idempotency_key` to the `sync_creatives` call envelope.
