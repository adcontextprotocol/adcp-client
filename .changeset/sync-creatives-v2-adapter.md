---
"@adcp/client": patch
---

Add v2/v3 adapter for sync_creatives requests

Introduces `adaptSyncCreativesRequestForV2` which strips the v3-only `account` field and `catalogs` array from each creative, and converts the v3 `status` enum (`'approved'` / `'rejected'`) to the v2 `approved` boolean before sending to v2 servers.
