---
"@adcp/client": minor
---

Fix schema .shape compatibility and add server-side helpers

- Fix 9 broken Zod request schemas that had .and() intersections breaking MCP SDK server.tool() registration
- Add typed response builders (capabilitiesResponse, productsResponse, mediaBuyResponse, deliveryResponse)
- Add adcpError() helper for L3-compliant structured error responses
- Add error extraction utilities for client-side error classification
- Add error compliance test scenario for comply
