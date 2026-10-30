---
'@adcp/sdk': patch
---

Reuse compiled MCP output-schema validators across tool listings and connections with a content-keyed LRU capped at 256 entries and 64 MiB of serialized schemas per MCP era. Preserve legacy and modern JSON Schema validation behavior, isolate schemas with conflicting `$id` values, and release compiler caches on eviction. Schemas exceeding the byte budget still validate but are not cached; generated validator code contributes additional memory beyond the schema-byte allowance.

Add reproducible performance comparisons using real AdCP schemas, with CI guards for repeated compilation, event-loop stalls, peak RSS, retained heap, and compiler retention after LRU eviction. Reports include an uncached reproduction and a hidden-cache memory-leak negative control.
