---
'@adcp/sdk': minor
---

feat(server): BuyerAgentRegistry — Phase 1 Stage 5 (caching decorator)

Phase 1 Stage 5 of #1269. Adds `BuyerAgentRegistry.cached(inner, options)` — a TTL-based caching decorator with concurrent-resolve coalescing and LRU eviction.

**Usage:**

```ts
const registry = BuyerAgentRegistry.cached(
  BuyerAgentRegistry.signingOnly({
    resolveByAgentUrl: async url => db.findBuyerAgent(url),
  }),
  { ttlSeconds: 60 }
);
```

**Properties:**

- **TTL-bounded.** Successful resolutions cached for `ttlSeconds` (default 60). Negative cache (null returns) is OPT-IN via `cacheNullsTtlSeconds` (default 0 — freshly onboarded agents are recognized within one request).
- **LRU-evicted.** Bounded to `maxSize` entries (default 10000). Map-iteration-order gives LRU-on-access for free; touch on hit re-inserts the entry as most-recent.
- **Concurrent-resolve coalesced.** N parallel `resolve()` calls on the same credential produce ONE upstream invocation; subsequent callers await the in-flight promise.
- **Per-kind cache keys.** Keys are namespaced (`http_sig:`, `api_key:`, `oauth:`) so a string colliding across credential kinds (e.g., an `agent_url` matching an `api_key.key_id` value) cannot leak an agent from one resolution path to another.
- **Skips uncacheable inputs.** When `credential === undefined`, `resolve()` falls through to the inner registry on each call — adopters with custom auth that hasn't migrated to credential synthesis (Stage 3) see no behavior change.

Mirrors the `AsyncCachingJwksResolver` over `JwksResolver` pattern already in `src/lib/signing/`.

16 new tests cover: TTL hit/miss, expiration, null caching opt-in, pass-through for undefined credential, per-kind key isolation, concurrent-resolve coalescing (10 parallel resolves → 1 upstream call, all see same result reference), LRU eviction with touch-on-hit, option validation. Full suite: 7412 pass, 0 fail.

This is the final stage of Phase 1's planned implementation. Phase 2 (#1292) — framework-level billing-capability enforcement and AdCP-3.1 error-code emission — remains gated on the SDK's 3.1 cutover.
