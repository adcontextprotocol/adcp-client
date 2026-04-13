---
"@adcp/client": patch
---

Fix adcp_major_version breaking v2 seller tool calls

- Stop injecting adcp_major_version into tool args for v2 sellers (strict Pydantic schemas reject it)
- Make ProtocolClient version-aware via serverVersion parameter
- Strip adcp_major_version in all v2 request adapters as belt-and-suspenders
