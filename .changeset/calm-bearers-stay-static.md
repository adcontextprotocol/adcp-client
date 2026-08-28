---
'@adcp/sdk': patch
---

Preserve static bearer and header credential rejections instead of misclassifying them as interactive OAuth, and require validated MCP protected-resource metadata before raising `NeedsAuthorizationError`.
