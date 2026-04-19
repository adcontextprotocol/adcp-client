---
'@adcp/client': minor
---

Idempotency support for AdCP v3 mutating requests. Implements [adcp-client#568](https://github.com/adcontextprotocol/adcp-client/issues/568) (client ergonomics) and [adcp-client#569](https://github.com/adcontextprotocol/adcp-client/issues/569) (server middleware) for the required-key changes in [adcp#2315](https://github.com/adcontextprotocol/adcp/pull/2315).

## What "just works" for existing callers

`npm update @adcp/client` is the full integration for most buyer-side apps:

- Client methods for mutating tools (`createMediaBuy`, `updateMediaBuy`, `activateSignal`, etc.) auto-generate a UUID v4 `idempotency_key` when the caller doesn't supply one. TypeScript input types were loosened to accept callers without a key — the method types for mutating tools now wrap their request with `MutatingRequestInput<T>`.
- Internal retries inside the SDK reuse the same key (re-generating defeats retry safety).
- `result.metadata.idempotency_key` surfaces the key that was sent, so callers can log it or persist it alongside the resource they created.
- `result.metadata.replayed` surfaces whether the seller returned a cached response for a prior retry.

## Things downstream users MUST actually do

Three cases require action:

1. **If your agent emits side effects on response** — notifications, LLM memory writes, downstream tool calls, UI toasts — you MUST check `result.metadata.replayed` before acting. A cached replay returning `replayed: true` means the side effects already fired on the original call; re-emitting is the exact bug this field exists to prevent.

2. **If you catch errors broadly**, new typed errors exist:
   - `IdempotencyConflictError` — same key used earlier with a different canonical payload. Mint a fresh UUID v4 and retry. This is the signal that an agent re-planned with a different intent, not a retry.
   - `IdempotencyExpiredError` — key is past the seller's replay window. If you know the prior call succeeded, look up the resource by natural key (e.g., `get_media_buys` by `context.internal_campaign_id`) before retrying. If you don't know, a fresh key is safe.

3. **If you BYOK** — persist `idempotency_key` to your own DB across process restarts — you own the replay-window boundary. Compare the key's age against `adcp.idempotency.replay_ttl_seconds` from `get_adcp_capabilities`. Past the window, fall back to natural-key lookup.

## Server-side middleware (`@adcp/client/server`)

New: `createIdempotencyStore({ backend, ttlSeconds })`. Pass the store to `createAdcpServer` and the framework handles:

- `INVALID_REQUEST` rejection when `idempotency_key` is missing or doesn't match the spec pattern `^[A-Za-z0-9_.:-]{16,255}$` (defense-in-depth against low-entropy keys and scope-injection via `\u0000` in the key)
- Replay cache with RFC 8785 JCS canonicalization of the payload hash (excludes `idempotency_key`, `context` *when it's the echo-back object shape — string-typed `context` on SI tools stays in the hash*, `governance_context`, and `push_notification_config.authentication.credentials`)
- `IDEMPOTENCY_CONFLICT` on same-key-different-payload (no payload/field/hash leak in the error body — spec-compliant read-oracle defense)
- `IDEMPOTENCY_EXPIRED` past TTL with ±60s clock-skew tolerance
- Concurrent-retry protection via atomic `putIfAbsent` claim step — parallel requests with the same fresh key see `SERVICE_UNAVAILABLE` with `retry_after: 1` rather than all racing to execute side effects
- `replayed: true` injection on the envelope for cached replays (cache stores the *formatted* envelope so non-deterministic wrap fields like `confirmed_at` are pinned; clones on every read so envelope stamps don't leak into the cache)
- Per-principal scoping via `resolveSessionKey` or explicit `resolveIdempotencyPrincipal(ctx, params, toolName)`
- **Per-session scoping for `si_send_message`** — the request `session_id` enters the scope tuple so the same key across two sessions doesn't cross-replay
- Only successful responses are cached (errors, `status: 'failed'`, and `status: 'canceled'` responses re-execute on retry — handler errors release the in-flight claim so a retry can re-execute rather than replay a transient failure)
- Auto-declares `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities` (REQUIRED per spec — clients MUST NOT assume a default)
- Server-creation guardrail: logs an error when mutating handlers are registered without an idempotency store (v3 non-compliance — buyer retries will double-book). Suppressed by explicitly setting `capabilities.idempotency.replay_ttl_seconds` in your config.

`ttlSeconds` must be between 3600 (1h) and 604800 (7d) per spec. Out-of-range values throw at `createIdempotencyStore` construction — silent clamping would hide operator misconfiguration (e.g., `60` meaning "one minute" becoming `3600` and misleading buyers about retry safety).

Backends:
- `memoryBackend()` — in-process Map, for tests and single-process training agents. Deep-clones on read and write so middleware mutations (envelope stamps, echo-back context) don't leak back into the cache.
- `pgBackend(pool, { tableName? })` — Postgres. Identifiers centrally quoted via `quoteIdent` for defense-in-depth. Includes `getIdempotencyMigration()` for DDL and `cleanupExpiredIdempotency(pool)` for periodic reclaim.

## Public API additions

```ts
// Client
import {
  IdempotencyConflictError,
  IdempotencyExpiredError,
  generateIdempotencyKey,
  isMutatingTask,
  isValidIdempotencyKey,
  canonicalize,
  canonicalJsonSha256,
  closeMCPConnections, // now re-exported from the root — previously only via ./protocols
  type MutatingRequestInput,
} from '@adcp/client';

// Server
import {
  createIdempotencyStore,
  memoryBackend,
  pgBackend,
  hashPayload,
  getIdempotencyMigration,
  cleanupExpiredIdempotency,
  type IdempotencyStore,
  type IdempotencyBackend,
} from '@adcp/client/server';
```

## Not breaking, despite the field becoming required in the spec

TypeScript request interfaces in `@adcp/client` mark `idempotency_key` as required (tracking the upstream schema), but the public client methods accept input without it and inject a key before sending. So existing call sites that omit `idempotency_key` continue to compile and run correctly. If you have code that constructs `CreateMediaBuyRequest` objects directly and sends them through raw MCP/A2A clients (bypassing `SingleAgentClient` / `AgentClient` / `ADCPMultiAgentClient`), add an `idempotency_key` — or route through the SDK methods, which handle it.
