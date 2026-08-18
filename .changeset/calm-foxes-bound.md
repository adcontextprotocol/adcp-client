---
'@adcp/sdk': minor
---

Bound long-lived client and server caches and add a 60-second default deadline plus a 2 MiB response-body cap to `createUpstreamHttpClient`. Canonical-reference resolvers now use a count- and byte-bounded LRU by default, A2A client discovery and multi-host metadata caches evict least-recent entries, and upstream calls accept per-client/per-call `requestTimeoutMs`, `maxResponseBytes`, and caller cancellation. Set either numeric option to `0` to disable that bound.
