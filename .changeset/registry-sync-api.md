---
"@adcp/client": minor
---

Add RegistrySync for in-memory registry replica with agent/authorization indexes, event feed polling, and zero-latency lookups. Add `lookupDomains()` for concurrent domain→agent resolution. Parallelize `lookupPropertiesAll()` with configurable concurrency. Align registry sync types with live server.
