---
'@adcp/sdk': patch
---

Project sync_accounts lookup references onto natural-key fields so strict account resolvers accept entries containing billing and other account settings. Preserve all natural-key dimensions when populating existing-account snapshots and enriching billing terms, including enrichment for implicit list_accounts.
