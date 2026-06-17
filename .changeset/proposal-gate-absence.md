---
"@adcp/sdk": patch
---

fix(conformance): skip proposal storyboards when supports_proposals is absent

Treat omitted `media_buy.supports_proposals` as unsupported for proposal lifecycle
`requires_capability` gates, including profiles without raw capabilities.
