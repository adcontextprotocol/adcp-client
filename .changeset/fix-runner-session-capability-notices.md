---
'@adcp/sdk': patch
---

Fix storyboard account selection for default implicit-account capabilities and agency-operated brands; reuse and gracefully close caller-owned MCP workflow sessions while treating session 404s as terminal and never implicitly replaying ambiguous tool-call failures; and surface schema-invalid `get_adcp_capabilities` responses as structured preflight notices.
