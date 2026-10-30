---
'@adcp/sdk': patch
---

Reuse compiled MCP output-schema validators across tool listings and connections with a bounded, content-keyed LRU cache. Preserve legacy and modern JSON Schema validation behavior, isolate schemas with conflicting `$id` values, and release compiler caches on eviction.

Add reproducible performance comparisons using real AdCP schemas, with CI guards for repeated compilation, event-loop stalls, peak RSS, retained heap, and compiler retention after LRU eviction. Reports include an uncached reproduction and a hidden-cache memory-leak negative control.
