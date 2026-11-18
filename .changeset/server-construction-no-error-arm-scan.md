---
'@adcp/sdk': patch
---

Build a server without reading the schema root. `createAdcpServer` computed the Error-arm inventory of its AdCP version and never used it, because two-layer error emission looks the inventory up again per request. The scan decompressed the packaged bundle and expanded every response schema, about 1.8 s of a cold first construction. Construction now reads no schema document. Server behavior is unchanged.
