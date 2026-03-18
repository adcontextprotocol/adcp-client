---
'@adcp/client': patch
---

Fix capability discovery cross-validation for creative-only agents

- Add sync_creatives to CREATIVE_TOOLS — creative library agents legitimately expose this without media_buy support
- Fix cross-validation to ignore shared tools when detecting unreported protocols — tools appearing in multiple protocol lists (list_creative_formats, list_creatives, sync_creatives) no longer falsely flag creative-only agents as having unreported media_buy support
- Make build_creative optional for tag-serving agents — agents that retrieve tags for existing creatives rather than generating new ones can legitimately omit build_creative, now tracked as warning instead of failure
- Improve validation messages to clarify why certain tools are optional for different agent types

Fixes #330 by properly supporting tag-serving creative agents without media_buy protocol
