# Migrating from @adcp/client 5.1.0 to 5.2.0

5.2.0 tracks **AdCP 3.0 GA**. The release is additive for most agents, but four surface changes have real migration weight. Fix them in this order.

## 1. Drop `authority_level` from governance plans (breaking)

The `authority_level` enum on governance `Plan` was split into two independent concerns. The field is gone; write the new fields instead.

**Before (5.1.0):**

```typescript
const plan = {
  plan_id: 'gov_acme_conditional',
  budget: { total: 100_000, currency: 'USD' },
  authority_level: 'agent_limited',   // removed
};
```

**After (5.2.0):**

```typescript
const plan = {
  plan_id: 'gov_acme_conditional',
  budget: {
    total: 100_000,
    currency: 'USD',
    reallocation_threshold: 8_000,       // absolute currency the orchestrator can reallocate without human sign-off
    // or: reallocation_unlimited: true  // full autonomy up to `total`
  },
  human_review_required: false,          // GDPR Art 22 / EU AI Act Annex III — true if actions on this plan must be human-reviewed
};
```

Handler logic that branched on `plan.authority_level === 'human_required'` now branches on `plan.human_review_required`. The response pattern is also new: human review is signalled as `status: 'denied'` + a `category_id: 'HUMAN_REVIEW_REQUIRED'` finding with `severity: 'critical'`; the old `'escalated'` status was dropped.

## 2. `inventory-lists` → `property-lists` (specialism rename)

If you claim `inventory-lists` in `get_adcp_capabilities`, rename it:

```diff
-  specialisms: ['inventory-lists']
+  specialisms: ['property-lists']
```

Tool names were already `property_list` — only the specialism ID moved. `collection-lists` is new in 3.0 for program-level brand safety (shows/series/podcasts via IMDb/Gracenote/EIDR IDs).

## 3. `domain:` → `protocol:` on specialism yaml (terminology)

If any of your tooling reads `compliance/cache/*/specialisms/<id>/index.yaml`, the top-level `domain:` field was renamed to `protocol:`. Update YAML consumers to read the new key.

## 4. `audience-sync` reclassified to media-buy (specialism + skill)

`audience-sync` moved from `protocol: governance` to `protocol: media-buy`. Its tools (`sync_audiences`, `list_accounts`) already lived under the media-buy protocol — only the specialism classification changed. If you built your audience-sync handlers expecting the governance agent, move them: `sync_audiences` lives under `eventTracking` in `createAdcpServer`; `list_accounts` lives under `accounts`.

## 5. RFC 9421 signed requests (new; opt-in)

Two new client-side behaviors auto-apply when you configure `AgentConfig.request_signing`:

- `ProtocolClient` / `AdCPClient` primes from `get_adcp_capabilities` on first call, caches the seller's `request_signing` advertisement for 300s, and signs outbound calls per the seller's `required_for` / `supported_for` policy.
- `createSigningFetch.coverContentDigest` accepts a predicate for per-request content-digest decisions.

Opt in by adding a `request_signing` block to your `AgentConfig`:

```typescript
const agent: AgentConfig = {
  url: 'https://seller.example.com/mcp',
  request_signing: {
    kid: 'buyer-kid-2026',
    alg: 'EdDSA',
    private_jwk: { /* includes `d` — keep this secret */ },
    agent_url: 'https://buyer.example.com',
    always_sign: false,     // default: obey seller's required_for / supported_for
  },
};
```

Server-side verification is a separate concern — see `skills/build-seller-agent/SKILL.md` § signed-requests. The new server verifier API surface is:

- `verifyRequestSignature(request, options)` — low-level, `preTransport`-shaped
- `createExpressVerifier({ capability, jwks, replayStore, revocationStore, resolveOperation })` — Express middleware
- `VerifierCapability` — shape advertised in `get_adcp_capabilities.capabilities.request_signing`
- `StaticJwksResolver(keys: AdcpJsonWebKey[])` — array of JWKs (NOT `{ kid: jwk }` keyed object)
- `InMemoryRevocationStore({ issuer, updated, next_update, revoked_kids, revoked_jtis })` — constructor seeds from a revocation snapshot; there is no `.insert()` method

If you ran 5.2.0-beta against an earlier snapshot of these APIs, expect constructor-signature changes.

## 6. Server auth middleware (new; recommended)

`serve()` gained four new options. Fully additive — your existing agents keep working without them — but unauthenticated agents fail the universal `security_baseline` storyboard.

```typescript
import { serve } from '@adcp/client';
import { verifyApiKey, verifyBearer, anyOf } from '@adcp/client/server';

serve(createAgent, {
  publicUrl: 'https://seller.example.com/mcp',   // canonical RFC 8707 audience
  authenticate: anyOf(
    verifyApiKey({ verify: lookupApiKey }),
    verifyBearer({
      jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      issuer: 'https://auth.example.com',
      audience: 'https://seller.example.com/mcp',
    }),
  ),
  protectedResource: { authorization_servers: ['https://auth.example.com'] },
});
```

`verifyApiKey` / `verifyBearer` / `anyOf` are exported from `@adcp/client/server`, not the root barrel. The root barrel exports only `serve` itself.

## 7. `idempotency_key` required on every mutating request (breaking)

AdCP 3.0 GA requires `idempotency_key` on every mutating tool. The SDK rejects requests without one at `INVALID_REQUEST` — before your handler runs. Wire idempotency into `createAdcpServer`:

```typescript
import { createAdcpServer, serve } from '@adcp/client';
import { createIdempotencyStore, memoryBackend } from '@adcp/client/server';

serve(() => createAdcpServer({
  idempotency: createIdempotencyStore({
    backend: memoryBackend(),  // production: pgBackend(pool)
    ttlSeconds: 86400,          // must be in [3600, 604800]
  }),
  resolveSessionKey: (ctx) => ctx.account?.id ?? 'default',
  mediaBuy: { /* handlers */ },
}));
```

Mutating tools (the SDK's `MUTATING_TASKS` constant is authoritative): `create_media_buy`, `update_media_buy`, `sync_accounts`, `sync_creatives`, `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `sync_plans`, `sync_governance`, `provide_performance_feedback`, `acquire_rights`, `activate_signal`, `log_event`, `report_usage`, `report_plan_outcome`, `create_property_list` / `update_property_list` / `delete_property_list`, `create_collection_list` / `update_collection_list` / `delete_collection_list`, `create_content_standards` / `update_content_standards` / `calibrate_content`, `si_initiate_session` / `si_send_message`.

The framework handles payload-hash conflict detection (`IDEMPOTENCY_CONFLICT`), TTL expiry (`IDEMPOTENCY_EXPIRED`), in-flight parallelism (`SERVICE_UNAVAILABLE` + `retry_after: 1`), and `replayed: true` injection. Don't roll your own `ctx.store.get('idempotency', key)` pattern.

## 8. `taskToolResponse` return for async `submitted` flows

`create_media_buy` for guaranteed buys with human IO signing is now modelled at the **MCP task layer**, not as a MediaBuy status. Return a task envelope — no `media_buy_id`, no `packages`, no `pending_approval` status on MediaBuy.

```typescript
import { taskToolResponse, registerAdcpTaskTool } from '@adcp/client/server';

// Inside your task-capable create_media_buy handler:
return taskToolResponse(
  {
    status: 'submitted',
    task_id: taskId,
    message: 'Awaiting IO signature from sales team',
  },
  'IO signature pending',
);
```

When the IO is signed, emit the final `create_media_buy` result — carrying `media_buy_id` and `packages` — to the buyer's `push_notification_config.url` (or the next `tasks/get` poll). Buyers then call `get_media_buys` with that `media_buy_id`.

## Quick checklist

- [ ] Replace `plan.authority_level` with `plan.budget.reallocation_threshold` (or `reallocation_unlimited`) + `plan.human_review_required`.
- [ ] Rename `'inventory-lists'` → `'property-lists'` in your `get_adcp_capabilities` response.
- [ ] Update yaml consumers that read the `domain:` key → `protocol:`.
- [ ] Move `audience-sync` tools under `accounts` + `eventTracking` in the seller skill's `createAdcpServer` call (not under `governance`).
- [ ] Wire `createIdempotencyStore` + `createAdcpServer({ idempotency })`. Remove any manual `ctx.store.get('idempotency', …)` patterns.
- [ ] Wire `serve({ authenticate, publicUrl, protectedResource })` with `verifyApiKey` / `verifyBearer` from `@adcp/client/server`.
- [ ] For guaranteed buys that need IO signing: return a task envelope via `taskToolResponse`, not a populated MediaBuy.

See `skills/build-seller-agent/SKILL.md` § Protocol-Wide Requirements and § Composing OAuth, signing, and idempotency for the fully wired reference.
