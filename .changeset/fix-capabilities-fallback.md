---
"@adcp/client": patch
---

Fix getCapabilities() silently falling back to synthetic v2 for v3 agents. Make publisher_domains optional in GetAdCPCapabilitiesResponse schema so agents that omit it (e.g. OpenAds) pass validation. Replace bare catch {} with diagnostic logging and re-throw for auth/timeout errors.
