---
'@adcp/sdk': patch
---

Recognize `ACTION_NOT_ALLOWED` through the shared standard error-code runtime table so decisioning `AdcpError` construction does not warn for the AdCP 3.1 code.
