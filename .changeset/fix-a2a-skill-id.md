---
"@adcp/client": patch
---

Fix A2A capability detection using `skill.id` instead of `skill.name` for tool mapping, so `buildSyntheticCapabilities` correctly identifies protocols like `media_buy` from A2A agent cards
