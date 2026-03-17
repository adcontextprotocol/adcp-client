---
'@adcp/client': minor
---

Fix creative protocol testing issues and add creative_lifecycle scenario

- Fix preview_creative test calls to use current schema (request_type: 'single' + creative_manifest)
- Remove incorrect media_buy gate on sync_creatives (now dual-domain with creative protocol)
- Fix cross-validation false positives from shared tools (list_creative_formats, list_creatives, sync_creatives)
- Respect min_spend_per_package when building test media buy requests
- Add creative_lifecycle scenario: format validation, bulk sync, snapshot testing, build/preview
