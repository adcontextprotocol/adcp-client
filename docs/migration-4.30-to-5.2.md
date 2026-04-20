# Migrating from @adcp/client 4.30.1 to 5.2.0

5.2.0 tracks **AdCP 3.0 GA**. If you're on 4.30.1, you're crossing three minor/major releases — 5.0 (task-shape + framework changes), 5.1 (exports cleanup + storyboard tarball), and 5.2 (3.0 GA protocol alignment). This guide walks through them in impact order. The actually-breaking items are marked **BREAKING**; everything else is additive but recommended.

Work through the sections in order — later sections assume earlier ones have landed.

## Part 1 — Framework shape (5.0.0)

### 1a. **BREAKING** — `TaskResult` is a discriminated union

Failed tasks now use `status: 'failed'`, not `status: 'completed'`. MCP `isError` responses preserve the structured data (`adcp_error`, `context`, `ext`) instead of throwing at the client.

**Before (4.30.1):**

```typescript
const result = await client.callTool('create_media_buy', params);
if (result.status === 'completed' && result.adcp_error) {
  // 4.x: errors arrived on a completed response
  handleError(result.adcp_error);
}
```

**After (5.0.0+):**

```typescript
const result = await client.callTool('create_media_buy', params);
if (result.status === 'failed') {
  const err = result.adcp_error;  // accessor, not a nested field read
  if (result.isRetryable()) {
    await sleep(result.getRetryDelay());
    // retry
  }
}
```

New convenience accessors on `TaskResult`: `adcpError`, `correlationId`, `retryAfterMs`, `isRetryable()`, `getRetryDelay()`.

### 1b. Framework — use `createAdcpServer` instead of `createTaskCapableServer` + `server.tool()`

4.x skill code used the low-level pattern. 5.0 shipped the declarative builder. Migrate.

**Before:**

```typescript
import { createTaskCapableServer, GetProductsRequestSchema, productsResponse } from '@adcp/client';

const server = createTaskCapableServer('Seller', '1.0.0', { taskStore });
server.tool('get_products', 'Products', GetProductsRequestSchema.shape, async (args) => {
  return productsResponse({ products: [...], context: args.context });
});
```

**After:**

```typescript
import { createAdcpServer, serve } from '@adcp/client';

serve(() => createAdcpServer({
  name: 'Seller',
  version: '1.0.0',
  mediaBuy: {
    getProducts: async (params, ctx) => {
      return { products: [...], sandbox: true };   // response builder auto-applied, context auto-echoed
    },
  },
}));
```

`createAdcpServer` auto-generates `get_adcp_capabilities` from your registered handlers, auto-applies response builders, auto-echoes `context`/`ext`, and wires account resolution. The `createTaskCapableServer` path still works for custom tools but shouldn't be your default.

### 1c. New server-side response helpers

- `mediaBuyResponse(data)` — auto-defaults `revision`, `confirmed_at`, `valid_actions` based on `status`.
- `validActionsForStatus(status)` — map a MediaBuy status to the legal `valid_actions` list.
- `cancelMediaBuyResponse({...})` — requires cancellation metadata (refund_type, reason).

Applied automatically when you use `createAdcpServer` with a `mediaBuy` domain group. Only call them directly for custom wrappers.

### 1d. Creative asset record shape

`creatives[].assets` is now `Record<asset_id, Asset>` (keyed object), not an array. If you were generating storyboard payloads by hand or normalizing buyer inputs, update shape.

**Before:**

```typescript
creatives: [{
  creative_id: 'c1',
  assets: [{ asset_id: 'hero', asset_type: 'image', url: '...' }],
}]
```

**After:**

```typescript
creatives: [{
  creative_id: 'c1',
  assets: { hero: { asset_type: 'image', url: '...' } },
}]
```

### 1e. Brand-rights is a first-class server domain

If you were rolling your own `brandRights` tool registration via `server.tool()`, collapse it into `createAdcpServer({ brandRights: { getBrandIdentity, getRights, acquireRights } })`. Three tools have schemas; `update_rights` and `creative_approval` don't (tracked upstream at adcontextprotocol/adcp#2253).

## Part 2 — Exports and tooling cleanup (5.1.0)

### 2a. **BREAKING** — Storyboards no longer bundled in npm

The `storyboards/` directory was removed from the published package. Pull the compliance tarball via `npm run sync-schemas` — it fetches `/protocol/{version}.tgz` from adcontextprotocol.org, verifies sha256, and extracts to `schemas/cache/{version}/` + `compliance/cache/{version}/`. The cache ships with npm on first install — no network call required for default usage.

If you had code referencing `@adcp/client/storyboards/*` directly, switch to the new compliance-cache testing exports:

```typescript
import {
  resolveStoryboardsForCapabilities,
  loadComplianceIndex,
  getComplianceCacheDir,
} from '@adcp/client/testing';
```

Storyboard selection is now driven by the agent's `get_adcp_capabilities`: `supported_protocols` resolves to domain baselines; `specialisms` resolves to specialism bundles. The runner fails closed on unknown specialisms or missing-bundle cases.

### 2b. **BREAKING** — Removed exports and CLI flags

| Removed | Replacement |
|---|---|
| `ComplyOptions.platform_type` | Capability-driven selection (drop the option, or pass `storyboards: [id]`) |
| `ComplianceResult.platform_coherence` / `expected_tracks` | Gone — no replacement |
| `ComplianceSummary.tracks_expected` | Gone |
| `PlatformType`, `SalesPlatformType`, `CreativeAgentType`, `SponsoredIntelligenceType`, `AINativePlatformType`, `PlatformProfile`, `PlatformCoherenceResult`, `CoherenceFinding`, `InventoryModel`, `PricingModel` | Type exports — just delete usages |
| `getPlatformProfile`, `getAllPlatformTypes`, `getPlatformTypesWithLabels`, `PLATFORM_STORYBOARDS`, `getStoryboardIdsForPlatform`, `extractScenariosFromStoryboard`, `filterToKnownScenarios`, `loadBundledStoryboards`, `loadBundledScenarios`, `getStoryboardById`, `getScenarioById`, `getStoryboardsForPlatformType`, `getComplianceStoryboards`, `getApplicableComplianceStoryboards`, `listStoryboards` | Helper exports — replace with `resolveStoryboardsForCapabilities` + `loadBundleStoryboards` + `getComplianceStoryboardById` from `@adcp/client/testing` |
| CLI: `adcp storyboard list --platform-type`, `adcp storyboard run --platform-type`, `adcp storyboard run --list-platform-types` | CLI: `adcp storyboard run <agent>` (capability-driven), or `adcp storyboard run <agent> --file <path.yaml>` for one-off runs |

### 2c. Optimistic concurrency on `AdcpStateStore` (additive)

`putIfMatch(collection, id, data, expectedVersion)`, `getWithVersion(collection, id)`, and `patchWithRetry(store, collection, id, updateFn, options?)` are new. Both `InMemoryStateStore` and `PostgresStateStore` track a monotonic `version` per row. Postgres migration is non-breaking — `ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1`, no data rewrite.

Use `patchWithRetry` for read-modify-write updates instead of naive `get` + `put` — it retries on concurrent-writer conflicts automatically.

## Part 3 — AdCP 3.0 GA alignment (5.2.0)

### 3a. **BREAKING** — `authority_level` split into two fields

The governance `Plan.authority_level` enum is removed. Two separate fields cover the concerns independently.

**Before:**

```typescript
const plan = {
  plan_id: 'gov_acme',
  budget: { total: 100_000, currency: 'USD' },
  authority_level: 'agent_limited',
};
```

**After:**

```typescript
const plan = {
  plan_id: 'gov_acme',
  budget: {
    total: 100_000,
    currency: 'USD',
    reallocation_threshold: 8_000,       // absolute currency amount
    // or: reallocation_unlimited: true  // full autonomy up to `total`
  },
  human_review_required: false,          // GDPR Art 22 / EU AI Act Annex III
};
```

Handlers that branched on `plan.authority_level === 'human_required'` now branch on `plan.human_review_required`. Human review is signalled as `status: 'denied'` + a `HUMAN_REVIEW_REQUIRED` finding at `severity: 'critical'`. The old `'escalated'` status was dropped from the `check_governance` enum; the response enum is now exactly `approved | denied | conditions`.

### 3b. **BREAKING** — `inventory-lists` specialism renamed to `property-lists`

If you claim `inventory-lists` in `get_adcp_capabilities`:

```diff
-  specialisms: ['inventory-lists']
+  specialisms: ['property-lists']
```

Tool names were already `property_list`. New `collection-lists` specialism covers program-level brand safety via IMDb/Gracenote/EIDR IDs — not a rename, genuinely new.

### 3c. **BREAKING** — Specialism yaml field `domain:` → `protocol:`

If any tooling reads `compliance/cache/*/specialisms/<id>/index.yaml` directly, update consumers to read `protocol:` instead of `domain:`.

### 3d. **BREAKING** — `audience-sync` reclassified from governance to media-buy

Handlers that were registered under a governance agent's `governance` domain group need to move to the seller skill's `accounts` + `eventTracking` domain groups. `sync_audiences` is overloaded — discovery (empty audiences array), add (`a.add: [{hashed_email}|{hashed_phone}]`), delete (`a.delete: true`). There is no separate `delete_audience` tool.

### 3e. **BREAKING** — `idempotency_key` required on every mutating request

The SDK rejects mutating requests without `idempotency_key` as `INVALID_REQUEST` **before your handler runs**. Wire `createIdempotencyStore` into `createAdcpServer`:

```typescript
import { createAdcpServer, serve } from '@adcp/client';
import { createIdempotencyStore, memoryBackend } from '@adcp/client/server';

serve(() => createAdcpServer({
  idempotency: createIdempotencyStore({
    backend: memoryBackend(),  // production: pgBackend(pool) — see § Going to Production in build-seller-agent
    ttlSeconds: 86400,          // must be in [3600, 604800]
  }),
  resolveSessionKey: (ctx) => ctx.account?.id ?? 'default',
  mediaBuy: { /* handlers */ },
}));
```

The complete mutating-tool list (the SDK's `MUTATING_TASKS` constant is authoritative): `create_media_buy`, `update_media_buy`, `sync_accounts`, `sync_creatives`, `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `sync_plans`, `sync_governance`, `provide_performance_feedback`, `acquire_rights`, `activate_signal`, `log_event`, `report_usage`, `report_plan_outcome`, `create_property_list`/`update_property_list`/`delete_property_list`, `create_collection_list`/`update_collection_list`/`delete_collection_list`, `create_content_standards`/`update_content_standards`/`calibrate_content`, `si_initiate_session`/`si_send_message`.

The framework handles replay detection, payload-hash conflict (`IDEMPOTENCY_CONFLICT`), TTL expiry (`IDEMPOTENCY_EXPIRED`), in-flight parallelism (`SERVICE_UNAVAILABLE` + `retry_after: 1`), and `replayed: true` injection. Remove any manual `ctx.store.get('idempotency', key)` patterns.

### 3f. **BREAKING** — `create_media_buy` with IO approval returns a task envelope

Guaranteed buys that require IO signing are modelled at the **MCP task layer**, not with a `pending_approval` MediaBuy status (that value is not in `MediaBuy.status`). Return a task envelope from the `create_media_buy` handler — no `media_buy_id`, no `packages`, not yet.

```typescript
import { taskToolResponse } from '@adcp/client/server';

createMediaBuy: async (params, ctx) => {
  if (needsIoSigning(params)) {
    const taskId = `task_${randomUUID()}`;
    return taskToolResponse(
      { status: 'submitted', task_id: taskId, message: 'Awaiting IO signature from sales team' },
      'IO signature pending',
    );
  }
  // ... synchronous MediaBuy path
},
```

When the IO is signed, emit the final `create_media_buy` result (carrying `media_buy_id` and `packages`) to the buyer's `push_notification_config.url` or to the next `tasks/get` poll.

### 3g. Server auth middleware (additive; required for compliance)

An agent that accepts unauthenticated requests fails the universal `security_baseline` storyboard. Wire one of the new helpers.

```typescript
import { serve } from '@adcp/client';
import { verifyApiKey, verifyBearer, anyOf } from '@adcp/client/server';

serve(createAgent, {
  publicUrl: 'https://seller.example.com/mcp',           // canonical RFC 8707 audience
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

`verifyApiKey` / `verifyBearer` / `anyOf` are exported from `@adcp/client/server`, **not** the root barrel. The root barrel exports only `serve`.

### 3h. RFC 9421 request signing (additive; opt-in)

Client-side: `AgentConfig.request_signing` auto-signs outbound MCP/A2A calls per the seller's advertised `required_for` / `supported_for` policy. `ProtocolClient` / `AdCPClient` prime from `get_adcp_capabilities` on first use and cache for 300s.

```typescript
const agent: AgentConfig = {
  url: 'https://seller.example.com/mcp',
  request_signing: {
    kid: 'buyer-kid-2026',
    alg: 'EdDSA',
    private_jwk: { /* includes `d` — keep secret */ },
    agent_url: 'https://buyer.example.com',
    always_sign: false,
  },
};
```

Server-side: see `skills/build-seller-agent/SKILL.md` § signed-requests for `verifyRequestSignature` / `StaticJwksResolver` / `InMemoryRevocationStore` wiring. The real APIs are:

- `StaticJwksResolver(keys: AdcpJsonWebKey[])` — array, not `{kid: jwk}` keyed object.
- `InMemoryRevocationStore({ issuer, updated, next_update, revoked_kids, revoked_jtis })` — constructor-only; no `.insert()` method.
- `VerifierCapability` — `{ supported, covers_content_digest, required_for, warn_for?, supported_for? }`; no `agent_url` or `per_keyid_request_rate_limit` field.

## Migration checklist

Work this list in order — earlier items are prerequisites for later ones.

### Framework shape (5.0.0)
- [ ] Replace `createTaskCapableServer` + `server.tool(...)` with `createAdcpServer({ ...domain groups... })`.
- [ ] Switch `TaskResult` branches from `status === 'completed' && adcp_error` to `status === 'failed'` and use accessors.
- [ ] Update any `creatives[].assets` array payloads to keyed-object form.
- [ ] If you had custom `brandRights` tool registration, collapse to `createAdcpServer({ brandRights })`.

### Exports (5.1.0)
- [ ] Delete `ComplyOptions.platform_type` callers and `PlatformType`/`PlatformProfile`/`getPlatformProfile` imports.
- [ ] Replace CLI `--platform-type` usage with capability-driven runs or `--file <path.yaml>`.
- [ ] Switch storyboard-file imports to `@adcp/client/testing` helpers.

### AdCP 3.0 GA (5.2.0)
- [ ] Replace `plan.authority_level` with `plan.budget.reallocation_threshold` / `reallocation_unlimited` + `plan.human_review_required`.
- [ ] Rename `inventory-lists` → `property-lists` in `get_adcp_capabilities`.
- [ ] Update yaml consumers from `domain:` → `protocol:`.
- [ ] Move `audience-sync` handlers to the seller skill's `accounts` / `eventTracking` domain groups.
- [ ] Wire `createIdempotencyStore` into `createAdcpServer({ idempotency })`. Remove manual `ctx.store.get('idempotency', …)` code.
- [ ] Wire `serve({ authenticate, publicUrl, protectedResource })`.
- [ ] For guaranteed buys requiring IO signing: return `taskToolResponse({ status: 'submitted', task_id, message })` — not a populated MediaBuy.
- [ ] (Optional) Claim `signed-requests` and wire `verifyRequestSignature` via `serve({ preTransport })`.

See `skills/build-seller-agent/SKILL.md` § Protocol-Wide Requirements and § Composing OAuth, signing, and idempotency for the fully wired reference agent.
