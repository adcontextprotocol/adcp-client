---
"@adcp/client": patch
---

Fix brand field being silently stripped when a v3 server is misdetected as v2. The v2 adapter renames brand → brand_manifest, but the schema filter then drops brand_manifest when the tool schema declares brand. Added adapter alias reconciliation so brand_manifest maps back to brand when the schema expects it. Improved version detection logging to surface why get_adcp_capabilities failures cause v2 fallback.
