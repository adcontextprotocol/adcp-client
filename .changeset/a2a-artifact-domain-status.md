---
"@adcp/sdk": patch
---

Disambiguate A2A artifact `status` fields so domain payloads like `update_media_buy` returning `status: "canceled"` are treated as completed tool responses, not task lifecycle cancellations. Parser, validator, task polling, and signing discovery logic now consistently read the latest structured DataPart.
