---
'@adcp/sdk': minor
---

feat(server, signing): Redis backends for ctx-metadata and ReplayStore

Adds two more Redis-backed stores alongside the existing memory and Postgres variants. Same shape as the idempotency Redis backend: `RedisClientType | <NarrowInterface>` union so node-redis users pass `createClient(...)` straight in without casts, `import type` keeps `redis` an optional peer dep with zero runtime coupling, shared one-time `console.warn` at construction when the default `keyPrefix` is paired with a Redis client we can confidently see on db 0.

```ts
import { createClient } from 'redis';
import { createCtxMetadataStore, redisCtxMetadataStore, createAdcpServer } from '@adcp/sdk/server';
import { RedisReplayStore } from '@adcp/sdk/signing/server';

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => console.error('redis error', err));
await redis.connect();

createAdcpServer({
  ctxMetadata: createCtxMetadataStore({ backend: redisCtxMetadataStore(redis) }),
  // ...
});

// And/or for signed-requests verifiers running multiple replicas:
const replayStore = new RedisReplayStore(redis);
```

**`redisCtxMetadataStore`** — factory function matching the pg backend pattern. Stores one Redis key per `(account_id, kind, id)` with the JSON payload `{ value, resource?, expiresAt? }`. Entries with no `expiresAt` are stored with **no Redis TTL** — ctx-metadata lifetimes can be months and silent eviction produces "package not found" errors that look like publisher bugs and run for weeks. When `expiresAt` is set, the backend stores with `EX = expiresAt - now + expiredGraceSeconds` (default 60s) so the store layer's own expiry check can still observe the value within the clock-skew window. `bulkGet` uses `MGET` for a single round trip per batch (witnessed in tests by a 100-key batch completing in <50ms locally). `clearAll` intentionally omitted — same rationale as the idempotency Redis backend.

**`RedisReplayStore`** — class-based to match `PostgresReplayStore`. Uses one Redis sorted set per `(keyid, scope)` pair, scored by `expiresAt`, members are nonces. A single Lua script does the atomic `ZREMRANGEBYSCORE -inf now` (drop expired) → `ZSCORE` (replay check) → `ZCARD` (cap check) → `ZADD` (insert) + `PEXPIREAT` (extend set TTL) sequence — guarantees the three-way `'ok' | 'replayed' | 'rate_abuse'` precedence (replay > rate_abuse > ok) is observed by every caller exactly once even under heavy concurrency. The `ReplayStore.insert` JSDoc literally names "Redis SET NX EX" as a canonical multi-replica primitive; this delivers on that. Has a `probe()` for boot-time readiness checks (not part of the base `ReplayStore` interface). No sweeper needed — expired nonces drop at every insert, abandoned sorted sets evict via `PEXPIREAT`.

**Shared default-prefix warning.** Both backends use `src/lib/utils/redis-default-prefix-warn.ts` — a single process-once `console.warn` when the default `keyPrefix` is paired with a node-redis client on db 0 (the strong signal of a shared/non-dedicated Redis). Fires at most once per process across every Redis backend instance, stays silent for escape-hatch clients (ioredis, Upstash, test doubles) where we can't introspect the db index, stays silent when `keyPrefix` is explicit or `suppressDefaultPrefixWarning: true`. The idempotency Redis backend (PR #1855, separately on `bokelley/redis-backends`) has the same logic inline; a follow-up will dedupe it onto this shared helper after both PRs land.

**`redis` peer dep** moves to `peerDependencies` (`^4.6.0 || ^5.0.0`) + `peerDependenciesMeta.redis.optional = true`. Same shape as `pg`.

**Tests** (skipped when `REDIS_URL` not set):

- ctx-metadata: 5 warn-suite (pure-function, run unconditionally) + 16 live-Redis integration (durable vs TTL'd entries, resource field round-trip, bulkGet single-round-trip witness, keyPrefix isolation, corrupt-value with `Error.cause` and no key leak, store-level integration).
- replay: 6 warn-suite + 14 live-Redis (probe, insert/has/replayed/different-scope-no-collision, expired-nonce reclaim, cap enforcement with precedence-test for replay-wins-over-cap, isCapHit unexpired-only count, concurrent same-nonce race, concurrent cap-boundary race, input validation, keyPrefix isolation, sorted-set PEXPIREAT extension).
