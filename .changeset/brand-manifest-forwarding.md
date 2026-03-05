---
"@adcp/client": patch
---

Fix brand_manifest forwarding to v3 agents in create_media_buy and get_products requests. The normalizer stashes brand_manifest before validation (which requires brand per the latest schema) and re-injects it after validation so agents that still require the field receive it.
