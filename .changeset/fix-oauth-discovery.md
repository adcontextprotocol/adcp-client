---
'@adcp/client': patch
---

Fix OAuth discovery to use RFC 8414 path-aware resolution, trying `{origin}/.well-known/oauth-authorization-server{path}` before falling back to root
