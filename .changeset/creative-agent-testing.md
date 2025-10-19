---
"@adcp/client": minor
---

Add creative agent testing UI and improve error detection

- Add creative testing UI with full lifecycle workflow (list formats → select → build/preview)
- Fix FormatID structure to send full {agent_url, id} object per AdCP spec
- Improve error detection to check for data.error field in agent responses
- Update to AdCP v2.0.0 schemas with structural asset typing
- Add FormatID type safety to server endpoints
- Support promoted_offerings asset type with BrandManifestReference
