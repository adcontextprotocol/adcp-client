---
'@adcp/client': minor
---

Complete the remaining client-side idempotency gaps from [#568](https://github.com/adcontextprotocol/adcp-client/issues/568) left open after PR #590.

## What changed

### Typed error instances on `TaskResult` for idempotency failures

`result.errorInstance` is populated with a typed `ADCPError` subclass when the seller's error code has a dedicated class — currently `IdempotencyConflictError` and `IdempotencyExpiredError`. Callers can now write:

```ts
const result = await client.createMediaBuy({...});
if (result.errorInstance instanceof IdempotencyConflictError) {
  // Mint a fresh UUID v4 and retry
}
```

The SDK pulls the sent `idempotency_key` from tracked task state when constructing the error — the server intentionally omits the key from error bodies (it's a read-oracle), so the transport-layer caller is the authoritative source. A new `adcpErrorToTypedError(adcpError, key)` helper is exported for callers who already have an `AdcpErrorInfo` in hand and want to type-narrow it themselves.

### `getIdempotencyReplayTtlSeconds()` with fail-closed behaviour

New method on `SingleAgentClient` / `AgentClient` that reads `adcp.idempotency.replay_ttl_seconds` from cached capabilities. Returns `undefined` on v2 sellers (pre-idempotency-envelope), the declared number on compliant v3 sellers, and **throws** when a v3 seller omits the declaration. No silent 24h default — the spec makes the declaration REQUIRED, and silently defaulting would mislead retry-sensitive flows.

`AdcpCapabilities` now carries an `idempotency?: { replayTtlSeconds }` field populated from the v3 capabilities response. `parseCapabilitiesResponse` treats `0`, negative, or non-numeric values as "not declared" rather than coercing them.

### `useIdempotencyKey(key)` BYOK helper

Validates against `IDEMPOTENCY_KEY_PATTERN` (`^[A-Za-z0-9_.:-]{16,255}$`) up front and returns a `{ idempotency_key }` fragment to spread into mutating params. Catches persisted-key drift before the round-trip:

```ts
const key = await db.getOrCreateIdempotencyKey(campaign.id);
await client.createMediaBuy({ ...params, ...useIdempotencyKey(key) });
```

### Key logging hygiene

Idempotency keys are a retry-pattern oracle within their TTL, so the SDK no longer writes full keys to debug logs by default. MCP and A2A debug logs now show the first 8 characters of any `idempotency_key` followed by `…`. Set `ADCP_LOG_IDEMPOTENCY_KEYS=1` to opt into full logging for local debugging. New `redactIdempotencyKey(key)` helper is exported for applications that emit their own logs.

## Public API additions

```ts
import {
  adcpErrorToTypedError,
  useIdempotencyKey,
  redactIdempotencyKey,
  type IdempotencyCapabilities,
} from '@adcp/client';

// On SingleAgentClient / AgentClient:
const ttl = await client.getIdempotencyReplayTtlSeconds(); // throws on non-compliant v3
```

## Not a breaking change

`TaskResult.errorInstance` is additive — existing code that switches on `adcpError.code` still works untouched. The new `getIdempotencyReplayTtlSeconds()` method only throws when callers explicitly ask for it against a non-compliant seller.
