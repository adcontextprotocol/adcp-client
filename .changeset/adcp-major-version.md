---
"@adcp/client": minor
---

Send adcp_major_version on every request per adcontextprotocol/adcp#1959. Sellers can validate the declared version against their supported range and return VERSION_UNSUPPORTED on mismatch.
