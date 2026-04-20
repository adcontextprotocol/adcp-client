# Idempotency Crash Recovery

How a buyer agent recovers when a process crashes mid-retry without creating duplicate media buys.

## The failure mode

A buyer process sends `create_media_buy` to a seller, the seller accepts it, but the process crashes before it can persist the response. On restart, the buyer does not know whether the call landed. Three things can happen on the next attempt:

- **Normal replay** — the seller is still within its replay window and returns the cached response. `result.metadata.replayed` is `true`.
- **Conflict** — the same key was used but the buyer's planner emitted a different payload (e.g., LLM re-ran and budget changed). `IdempotencyConflictError`.
- **Expired** — the replay window elapsed before the buyer could confirm. `IdempotencyExpiredError`. Re-sending the same key at this point bypasses the seller's replay cache, so the seller would create a **second** media buy unless the buyer looks up by natural key first.

This guide shows the buyer-side recipe that handles all three.

## Persistence layout

Keep one row per logical order. The natural key is whatever identifier your system already uses (order ID, campaign ID, purchase request number). The idempotency key is a UUID v4 the buyer mints once and reuses across every retry for that order.

```sql
CREATE TABLE buyer_idempotency (
  natural_key      text PRIMARY KEY,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

The `created_at` column is what you compare against the seller's declared replay TTL. `natural_key` is not a seller-side concept — it is your handle for looking up the resource if the idempotency window expires.

## The recovery-safe send function

```typescript
import {
  ADCPMultiAgentClient,
  generateIdempotencyKey,
  useIdempotencyKey,
  IdempotencyConflictError,
  IdempotencyExpiredError,
} from '@adcp/client';
import type { CreateMediaBuyRequest } from '@adcp/client';
import { Pool } from 'pg';

const pool = new Pool();
const client = new ADCPMultiAgentClient([
  { id: 'seller', agent_uri: process.env.SELLER_URI!, protocol: 'mcp' },
]);

interface BuyerOrder {
  order_id: string; // your natural key
  request: Omit<CreateMediaBuyRequest, 'idempotency_key'>;
}

async function getOrCreateKey(orderId: string): Promise<{ key: string; ageSeconds: number }> {
  // Insert-or-select in one round trip. RETURNING gives us the row whether
  // we just inserted it or it already existed.
  const freshKey = generateIdempotencyKey();
  const { rows } = await pool.query(
    `INSERT INTO buyer_idempotency (natural_key, idempotency_key)
     VALUES ($1, $2)
     ON CONFLICT (natural_key) DO UPDATE SET natural_key = EXCLUDED.natural_key
     RETURNING idempotency_key, created_at`,
    [orderId, freshKey]
  );
  const row = rows[0];
  return {
    key: row.idempotency_key,
    ageSeconds: (Date.now() - new Date(row.created_at).getTime()) / 1000,
  };
}

async function rotateKey(orderId: string): Promise<string> {
  const freshKey = generateIdempotencyKey();
  await pool.query(
    `UPDATE buyer_idempotency
     SET idempotency_key = $2, created_at = now()
     WHERE natural_key = $1`,
    [orderId, freshKey]
  );
  return freshKey;
}

export async function sendCreateMediaBuy(order: BuyerOrder) {
  const seller = client.agent('seller');

  // Step 1. Resolve the idempotency key for this order. Persisted so a crashed
  // process can resume with the exact same key on restart.
  const { key, ageSeconds } = await getOrCreateKey(order.order_id);

  // Step 2. If the key is already older than the seller's replay TTL, a resend
  // would miss the cache and create a duplicate. Look up by natural key before
  // deciding. Throws ConfigurationError on v3 sellers that omit the declaration
  // (the SDK refuses to default to 24h). Returns undefined on v2 sellers — in
  // that case skip the TTL check and trust the error paths below.
  let currentKey = key;
  const ttl = await seller.getIdempotencyReplayTtlSeconds();
  if (ttl !== undefined && ageSeconds > ttl) {
    const existing = await lookupByNaturalKey(seller, order.order_id);
    if (existing) return existing; // prior call already landed; nothing to do
    // Prior call did not land. Rotate to a fresh key before sending.
    currentKey = await rotateKey(order.order_id);
  }

  // Step 3. Send with the persisted (or freshly-rotated) key. useIdempotencyKey
  // validates against ^[A-Za-z0-9_.:-]{16,255}$ before the round-trip so a
  // corrupted row fails locally instead of as a remote INVALID_REQUEST.
  const result = await seller.createMediaBuy({
    ...order.request,
    ...useIdempotencyKey(currentKey),
  });

  // Step 4. Handle typed error instances BEFORE treating the call as success.
  // errorInstance is populated alongside adcpError when the code has a
  // dedicated class.
  if (result.errorInstance instanceof IdempotencyConflictError) {
    // Planner re-ran and emitted a different payload under the same key.
    // Treat as a new intent: mint a fresh key and retry once.
    const nextKey = await rotateKey(order.order_id);
    return seller.createMediaBuy({
      ...order.request,
      ...useIdempotencyKey(nextKey),
    });
  }
  if (result.errorInstance instanceof IdempotencyExpiredError) {
    // Window closed between our TTL check and the seller's view (clock skew,
    // or the declared TTL is tighter than the ageSeconds gate caught).
    const existing = await lookupByNaturalKey(seller, order.order_id);
    if (existing) return existing;
    const nextKey = await rotateKey(order.order_id);
    return seller.createMediaBuy({
      ...order.request,
      ...useIdempotencyKey(nextKey),
    });
  }

  // Step 5. Gate side effects on replayed. A replay means the seller already
  // did the work on an earlier call; firing notifications / memory writes /
  // downstream tool calls again would double-count.
  if (result.success && !result.metadata.replayed) {
    await notify(`Campaign ${result.data.media_buy_id} created`);
  }

  return result;
}
```

`lookupByNaturalKey` and `notify` are your own functions. `lookupByNaturalKey` calls `get_media_buys` (or an equivalent seller read) filtered by whatever identifier your `order.request.context` or `packages[].buyer_ref` carries — the shape is seller-specific. The point is that when the replay window closes, the buyer reads the seller's canonical state rather than re-firing a mutating call blind.

Non-AdCP errors (transport, DNS, socket timeout) are not caught here. The persisted key stays in place; the next call through `sendCreateMediaBuy` resends the same key and lands on the seller's replay cache.

## Decision tree

On every attempt, evaluate in order:

1. **Is there a persisted key for this natural key?** No → generate one and persist before sending. Yes → load it.
2. **Is `now() - created_at > getIdempotencyReplayTtlSeconds()`?** Yes → call `lookupByNaturalKey`. Resource found → return it. Not found → rotate to a fresh key and continue.
3. **Send the request with the persisted key.**
4. **Did the call return a typed idempotency error on `result.errorInstance`?**
   - `IdempotencyConflictError` → payload mismatch under the same key. Rotate key, retry once. If it conflicts again, surface to the operator — your planner is non-deterministic on input the seller treats as material.
   - `IdempotencyExpiredError` → race between your TTL gate and the seller. Fall back to `lookupByNaturalKey`; rotate and retry if absent.
5. **Otherwise the response is `success`. Check `result.metadata.replayed`.** `true` → the seller is handing back a cached response; skip side effects. `false` → first landing; fire side effects as normal.

## Pitfalls

- **Don't regenerate the key on every retry.** A fresh key on retry defeats the replay cache — the seller sees a new request and creates a duplicate. Persist once per natural key and reuse.
- **Don't trust a `result.success === true` without checking `result.metadata.replayed`.** A cached replay is success-shaped but the work already happened. Firing side effects on both the original call and the replay is the top at-least-once bug.
- **Don't assume the seller's TTL is 24 hours.** `getIdempotencyReplayTtlSeconds()` throws on v3 sellers that fail to declare `adcp.idempotency.replay_ttl_seconds` and returns `undefined` on v2 sellers. The SDK does not default to 24h because a silent default misleads retry-sensitive flows. Catch the throw and fail the operation, or fall through the natural-key lookup path unconditionally on v2.
- **Don't persist idempotency keys in process memory.** An in-memory `Map` is gone on crash — the entire point of the pattern is surviving restart. Use Postgres, Redis with durability, or whatever your system already persists orders to.

## Related

- [README — Idempotency (mutating requests)](../../README.md#idempotency-mutating-requests)
- [`docs/llms.txt` — Idempotency](../llms.txt) — single-fetch protocol overview for AI agents.
- [`skills/build-seller-agent/SKILL.md` § Idempotency](../../skills/build-seller-agent/SKILL.md#idempotency) — seller-side view: what the framework does when a buyer resends a key.
