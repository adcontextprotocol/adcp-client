---
"@adcp/client": patch
---

Improve schema validation error messages for union response schemas (create_media_buy, activate_signal, build_creative, etc.). Previously, validation failures on these tools produced the unhelpful `(root): Invalid input`. Now reports the specific missing or invalid fields from the closest-matching schema variant (e.g., `media_buy_id: expected string, received undefined`). Also fixes TaskExecutor.extractResponseData() to retry unwrapping without schema validation when the initial call fails.
