# Idempotency — replay TTL and principal resolver

Framework handles replay/dedup automatically. You don't write idempotency logic in your handlers.

## What you don't have to do

- Hash request payloads
- Cache responses
- Detect replay-with-same-payload vs replay-with-different-payload conflicts
- Translate replays into the `replayed: true` envelope marker

The framework owns all of this via `createIdempotencyStore` (memory or Postgres backend). Run `getIdempotencyMigration()` once per database in production.

## When you might need to override

The framework synthesizes a default `resolveIdempotencyPrincipal` from `auth.client_id ?? sessionKey ?? account.id`. That covers the standard case (multi-tenant: each authenticated buyer gets its own idempotency namespace; single-tenant: one shared namespace).

Override only if your auth shape is unusual:

```ts
createAdcpServerFromPlatform(platform, {
  name: '...', version: '...',
  resolveIdempotencyPrincipal: (ctx) => ctx.authInfo?.subjectClaim ?? ctx.account?.id,
});
```

## Replay TTL

Default is 86400s (24h). Spec range: 3600 (1h) to 604800 (7d). Out-of-range throws at construction.

```ts
const idempotency = createIdempotencyStore({
  backend: pgBackend(pool),
  ttlSeconds: 86400,                 // 24h
});
createAdcpServerFromPlatform(platform, { name: '...', version: '...', idempotency, ... });
```

Capability projection automatic: framework declares `replay_ttl_seconds` on `get_adcp_capabilities` so buyers can reason about retry safety.

## Conflict semantics

If a buyer reuses an idempotency_key with a different payload, framework throws `IDEMPOTENCY_CONFLICT` automatically — you don't catch this. Buyer corrects with a fresh key.

Production-only flag: in tests / dev, your handler may throw `IdempotencyConflictError` directly to simulate the path:

```ts
import { IdempotencyConflictError } from '@adcp/sdk/server';
throw new IdempotencyConflictError({ details: { test_simulation: true } });
```

See `REFERENCE.md` for the full idempotency section.
