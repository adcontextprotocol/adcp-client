---
'@adcp/sdk': patch
---

Complete AdCP 3.2.0-beta.5 async adoption: carry buyer operation IDs in
application-layer webhook registration across MCP and A2A, reject malformed
beta.5 registrations before seller dispatch, converge terminal re-emissions
across delivery keys, and preserve failed or rejected task artifacts when
polling with `include_result`.
