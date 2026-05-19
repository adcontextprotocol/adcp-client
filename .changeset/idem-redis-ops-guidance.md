---
'@adcp/sdk': patch
---

docs(server): operational guidance for cached-response credentials and Redis memory policy

Closes adcp-client#1856 (cached credentials) and adcp-client#1857 (cache-fill DoS / maxmemory-policy).

**No code behavior changes** — only JSDoc + the `CTX-METADATA-SAFETY` guide gain the operational guidance that PR #1858's security review surfaced as deferred follow-ups. Adopters reading the entrypoint docstrings now see both classes of footgun at the read site.

**`IdempotencyStoreConfig` JSDoc (`src/lib/server/idempotency/store.ts`):** names the cached-response-at-rest concern explicitly. The hash-exclusion list strips credentials from the *hash* but the *stored response* is the handler's verbatim output. If a handler returns refreshed bearer tokens, signed governance payloads, or echoed `push_notification_config` credentials, those sit in the backend for `ttlSeconds`. Adopters: don't return credentials in handler responses; if you must, wrap with a scrubber or use a custom `IdempotencyBackend`. The SDK does not ship a built-in scrubber because it would change wire shape silently.

**`docs/guides/CTX-METADATA-SAFETY.md`:** new "Related: handler responses are cached for `ttlSeconds`" section cross-links to the idempotency JSDoc and the #1856 tracking issue. The two surfaces (`ctx_metadata` cache and idempotency response cache) have the same at-rest concern; one guide covers both.

**`redisBackend` JSDoc (`src/lib/server/idempotency/backends/redis.ts`):** Redis `maxmemory-policy` recommendation matrix — `volatile-lru` (recommended, evicts only TTL'd keys = AdCP's keyspace), `allkeys-lru` (dedicated db only), `noeviction` (fail-closed, paging instead of silent eviction). Pair with per-principal `VALIDATION_ERROR` rate alerting because a drifted handler under retry amplifies cache fill via `saveTransientError`.

**`RedisReplayStore` JSDoc (`src/lib/signing/redis-replay-store.ts`):** same memory-policy matrix, plus the eviction-on-replay caveat — if `volatile-lru` evicts a sorted set before its members would have expired naturally, an attacker's later replay sees a fresh set and gets `ok`. The per-`(keyid, scope)` cap (default 100k) is the primary defense; eviction is a secondary recovery mode. Size Redis to keep working set in memory; treat eviction as scale-up pressure, not a feature.

**`redisCtxMetadataStore` JSDoc (`src/lib/server/ctx-metadata/backends/redis.ts`):** memory-policy guidance tuned to ctx_metadata's durable-by-default semantics. `allkeys-lru` recommended on a dedicated db (re-hydration is automatic on miss, so eviction is safer here than for the replay store).

Pre-existing protocol-store issues, not Redis-introduced regressions; the docs now name them so adopters don't have to discover them in production.
