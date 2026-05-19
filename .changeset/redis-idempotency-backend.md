---
'@adcp/sdk': minor
---

feat(server): add Redis backend for the idempotency store

`createIdempotencyStore` now ships a third backend alongside `memoryBackend` (tests / single-process) and `pgBackend` (production). Redis is a natural fit for the AdCP v3 replay cache — atomic `SET … NX EX` maps directly to the `putIfAbsent` claim semantic, and key expiry is enforced by the engine rather than an explicit sweeper job.

```ts
import { createClient } from 'redis';
import { createAdcpServer, createIdempotencyStore, redisBackend } from '@adcp/sdk/server';

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => console.error('redis error', err));
await redis.connect();

const idempotency = createIdempotencyStore({
  backend: redisBackend(redis),
  ttlSeconds: 86400,
});

createAdcpServer({ idempotency /* ... */ });
```

**Reclaim semantics.** A crashed in-flight claim is naturally reclaimable on retry because Redis auto-deletes expired keys — no `WHERE expires_at < NOW()` dance like the Postgres backend.

**`expired` vs `miss` parity.** The store layer distinguishes `IDEMPOTENCY_EXPIRED` (cached entry past TTL within the clock-skew window) from `miss` (fresh execution). Redis would otherwise collapse these by evicting the key at the second it expires; the backend holds the value alive for an extra `expiredGraceSeconds` (defaults to 120s — covers the store's default 60s skew with margin) so the store can still return `expired` correctly. Configurable via `redisBackend(client, { expiredGraceSeconds })`.

**Key prefix.** All keys are prefixed (defaults to `"adcp:idem:"`) so a shared Redis instance can host multiple AdCP servers — or AdCP alongside other apps — without collision. Override via `redisBackend(client, { keyPrefix })`.

**Client shape.** The backend accepts a `RedisBackendClient = RedisClientType<any, any, any> | RedisLikeClient` union. Pass `createClient(...)` from the `redis` package straight in — node-redis is the documented path and typechecks without casts. `ioredis`, Upstash, or test doubles implement the narrow `RedisLikeClient` interface (4 methods: `get`, `set` with `{ EX, NX }`, `del`, `ping`); the JSDoc on `RedisLikeClient` ships a 7-line `ioredis` adapter example that handles the positional-args asymmetry. `RedisClientType` is imported via `import type` only — erased at emit, so `redis` stays a truly optional peer dep with zero runtime coupling.

**`clearAll` intentionally omitted.** A shared Redis instance is a production resource — accidentally calling `FLUSHDB` from a compliance reset hook would nuke unrelated keys. Test setups that want a clean slate should run against a dedicated db index (`REDIS_URL=…/15`) and call `FLUSHDB` themselves. Same rationale as the Postgres backend.

**Peer dependency.** `redis: ^4.6.0 || ^5.0.0` added as an optional peer dep (`peerDependenciesMeta.redis.optional = true`). Adopters who don't use the Redis backend pay no install cost.

**Test coverage.** 15 integration tests in `test/lib/idempotency-redis.test.js` mirror the Postgres backend's suite (probe, get/put round-trip, putIfAbsent claim + race, delete, JSON unicode/nesting, store-level check/save/conflict/expired round-trips) plus Redis-specific cases: `keyPrefix` isolation across apps sharing a db, corrupt-value surfacing as an explicit error, and the grace-window keeping `expired` distinguishable from `miss`. Skipped when `REDIS_URL` is not set.
