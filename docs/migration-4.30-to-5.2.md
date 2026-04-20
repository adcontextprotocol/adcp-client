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

When the IO is signed, emit the final `create_media_buy` result (carrying `media_buy_id` and `packages`) to the buyer's `push_notification_config.url` via `ctx.emitWebhook` (see 3i) or the next `tasks/get` poll.

**Buyer-side TypeScript update**: the generated `CreateMediaBuyResponse` union now includes a `CreateMediaBuySubmitted` branch. Exhaustive discriminations need to handle it:

```typescript
switch (response.status) {
  case 'completed': /* media_buy_id + packages on this branch */ break;
  case 'submitted': /* task_id only — media_buy_id lands on completion webhook */ break;  // NEW
  case 'input-required': /* ... */ break;
  // strict-TS: add 'submitted' or the exhaustiveness check fails
}
```

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

### 3h. **BREAKING** — Webhook payloads now carry `idempotency_key`

Upstream collapsed webhook dedup to a single canonical field. Every webhook payload now includes a required `idempotency_key` string (pattern `^[A-Za-z0-9_.:-]{16,255}$`). Affected types: `MCPWebhookPayload`, `ArtifactWebhookPayload`, `CollectionListChangedWebhook`, `PropertyListChangedWebhook`. One payload was renamed:

```diff
-  RevocationNotification.notification_id: string
+  RevocationNotification.idempotency_key: string
```

Publishers populating `notification_id` must rename the field. Receivers must dedupe by `idempotency_key` scoped to the authenticated sender identity. The SDK does this for you if you wire the new `webhookDedup` config (see 3j).

### 3i. Webhook emitter + `ctx.emitWebhook` (new, strongly recommended)

Publisher-side outbound webhook emission lands as a first-class SDK helper in 5.2 — the symmetric counterpart to the receiver-side dedup below. Wire `webhooks` on `createAdcpServer` and `ctx.emitWebhook` is populated on every handler's context.

```typescript
import { createAdcpServer, serve } from '@adcp/client';

serve(() => createAdcpServer({
  name,
  version,
  webhooks: {
    signerKey: { keyid: 'publisher-kid-2026', alg: 'ed25519', privateKey: /* JWK with d */ },
    // Optional: retries, idempotencyKeyStore, fetch
  },
  mediaBuy: {
    createMediaBuy: async (params, ctx) => {
      const media_buy_id = await persist(params);
      await ctx.emitWebhook({
        url: params.push_notification_config.url,
        payload: { task: { task_id, status: 'completed', result: { media_buy_id } } },
        operation_id: `create_media_buy.${media_buy_id}`,   // stable across retries
      });
      return { media_buy_id, packages: [] };
    },
  },
}));
```

What the emitter handles automatically:

- RFC 9421 signing with a fresh `nonce` per attempt (tag `adcp/webhook-signing/v1`; mandatory covered components are `@method`, `@target-uri`, `@authority`, `content-type`, `content-digest`).
- Stable `idempotency_key` per `operation_id` reused byte-for-byte across retries (regenerating on retry is the top at-least-once-delivery bug the conformance suite catches).
- JSON serialized once with compact separators (`,` / `:`, no spaces) so signature base and wire body come from the same bytes.
- Retry with exponential backoff + jitter on 5xx/429. Terminal on 4xx and on 401 responses carrying `WWW-Authenticate: Signature error="webhook_signature_*"` (retrying a signature failure is pointless).
- Pluggable `WebhookIdempotencyKeyStore` — default in-memory; swap in a durable backend for multi-replica publishers.
- HMAC-SHA256 / Bearer fallback for legacy buyers that registered `push_notification_config.authentication.credentials` — those still work but are deprecated (see 3k).

Raw `createWebhookEmitter` is also exported from `@adcp/client/server` if you're outside the `createAdcpServer` path.

### 3j. Receiver-side webhook dedup (new)

Opt in on the client side with one config option.

```typescript
import { AdCPClient } from '@adcp/client';
import { memoryBackend } from '@adcp/client/server';

const client = new AdCPClient(agents, {
  webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
  webhookSecret: process.env.WEBHOOK_SECRET,
  handlers: {
    webhookDedup: { backend: memoryBackend(), ttlSeconds: 86400 },  // 24h default
    onCreateMediaBuyStatusChange: async (result, metadata) => {
      // First delivery runs here; retries with the same idempotency_key are dropped
      // as Activity type 'webhook_duplicate'.
    },
  },
});
```

Dedup is per-agent + per-key. Reuses the same `IdempotencyBackend` interface as request-side idempotency (so `memoryBackend()` / `pgBackend(pool)` work here too). MCP payloads missing or malformed `idempotency_key` dispatch without dedup and log a warning; A2A payloads (which don't carry the field) dispatch silently.

**Breaking for strict TS callers**: the `Activity.type` union gains `'webhook_duplicate'`. Exhaustive switches on `Activity.type` with a `never` check need a new case (treat it the same as `webhook_received` in logging, or branch to suppress side effects).

### 3k. **DEPRECATED** — `PushNotificationConfig.authentication`

`PushNotificationConfig.authentication` is now optional and deprecated. Omitting it opts into the RFC 9421 webhook profile (the 4.0 default). Bearer and HMAC-SHA256 remain for backward compatibility with legacy buyers, but new integrations should rely on the signed-webhook profile the emitter defaults to.

### 3l. Webhook signing: receiver-side verifier (new, opt-in)

If you host a webhook receiver, verify signatures with `verifyWebhookSignature` from `@adcp/client/signing/server`:

```typescript
import {
  verifyWebhookSignature,
  BrandJsonJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} from '@adcp/client/signing/server';

// Ergonomic: discover the publisher's webhook-signing JWKS from their brand.json
// instead of pre-configuring per-counterparty jwks_uri.
const jwks = new BrandJsonJwksResolver('https://publisher.example/.well-known/brand.json', {
  agentType: 'sales',
});

await verifyWebhookSignature(request, {
  jwks,
  replayStore: new InMemoryReplayStore(),
  revocationStore: new InMemoryRevocationStore({ /* revoked_kids, revoked_jtis */ }),
});
```

The verifier throws `WebhookSignatureError` with a typed `webhook_signature_*` code on rejection (`window_invalid`, `key_unknown`, `content_digest_mismatch`, `rate_abuse`, `revocation_stale`, `alg_not_allowed`, `components_incomplete`, `header_malformed`, `params_incomplete`). Match these codes byte-identically in your 401 `WWW-Authenticate: Signature error=…` response — the conformance runner grades on the exact code.

### 3m. Storyboard runner webhook conformance (new)

If you're running storyboards against your agent, three new `expect_webhook*` pseudo-tasks grade outbound webhook behavior:

- `expect_webhook` — asserts delivery with well-formed `idempotency_key`
- `expect_webhook_retry_keys_stable` — rejects first N deliveries with 5xx then checks all retries carry the same `idempotency_key` byte-for-byte
- `expect_webhook_signature_valid` — delegates to `verifyWebhookSignature`

Configure `runStoryboard({ webhook_receiver, webhook_signing })` and use `{{runner.webhook_url:<step_id>}}` to inject ephemeral URLs into `push_notification_config.url` in your storyboard yaml.

### 3n. RFC 9421 request signing (additive; opt-in)

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

## v2 sunset

AdCP v2 went unsupported on 2026-04-20 as part of the 3.0 GA cutover ([adcp#2220](https://github.com/adcontextprotocol/adcp/issues/2220)). The client still executes v2 code paths — no functional break — but emits a one-time `console.warn` the first time a client instance sees v2 capabilities from an agent, so integrations don't accumulate subtle bugs against an unsupported surface. Suppress the warning with `ADCP_ALLOW_V2=1` (or `adcp --allow-v2` on the CLI) if you're knowingly running against a legacy holdout; upgrade the agent otherwise. Synthetic capabilities (agents that don't implement `get_adcp_capabilities`) don't fire the warning because their version is unknown.

<a id="webhook-hmac-legacy-deprecation"></a>

## Webhook HMAC legacy deprecation

**What.** The `type: 'hmac_sha256'` variant of `WebhookAuthentication` on outbound webhook emission — the one that emits `x-adcp-timestamp` + `x-adcp-signature: sha256=...` headers over `${ts}.${body_bytes}`.

**Why deprecated.** The spec-current webhook authentication is an RFC 9421 signature with `adcp_use: "webhook-signing"` JWKs (adcp#2423). HMAC predates the 9421 webhook mode and is kept only for buyers who registered `push_notification_config.authentication.credentials` before the 9421 rollout.

**Status in 5.x.** Supported, no behavioral change. The emitter logs a one-time `console.warn` the first time it emits an HMAC-signed webhook per process, so integrations surface the deprecation notice in logs without spamming every retry. The `WebhookAuthentication` type carries an `@deprecated` JSDoc tag flagging the `hmac_sha256` variant. Suppress the warning with `ADCP_SUPPRESS_HMAC_WARNING=1` if you're knowingly staying on HMAC until your buyers migrate.

**SDK vs spec status.** The AdCP spec still supports HMAC as a legacy fallback for buyers that registered `push_notification_config.authentication.credentials` — it is not spec-deprecated. The SDK flags it as deprecated to steer new integrations at the spec-current RFC 9421 path, but the implementation will remain until the spec itself retires the mode. No hard SDK removal date.

**Migration.** Switch emitters to the default 9421 path (omit `authentication` entirely, or pass `null`). Buyers verify with `verifyWebhookSignature` using a `BrandJsonJwksResolver` or a pre-configured JWKS URL — see the seller skill's webhook signing section and the `signed-requests` specialism doc for end-to-end wiring.

## Migration checklist

Work this list in order — earlier items are prerequisites for later ones.

### Schema enum additions (additive)

- `RightUse` enum adds `ai_generated_image`. Existing `brand-rights` agents can now declare and accept this use directly (previously needed workarounds).

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
- [ ] Handle the new `'submitted'` branch of the `CreateMediaBuyResponse` union in exhaustive client-side discrimination.
- [ ] Rename `RevocationNotification.notification_id` → `idempotency_key` on any publisher that emits revocation webhooks.
- [ ] Wire `createAdcpServer({ webhooks: { signerKey } })` for any handler that emits async completion webhooks; replace hand-rolled `fetch` + HMAC signing with `ctx.emitWebhook`.
- [ ] On the client side, add `handlers: { webhookDedup: { backend: memoryBackend() } }` to `AdCPClient`. Handle the new `Activity.type === 'webhook_duplicate'` branch in any exhaustive switches.
- [ ] (Optional) Claim `signed-requests` and wire `verifyRequestSignature` via `serve({ preTransport })`.
- [ ] (Optional, recommended) Verify inbound webhooks with `verifyWebhookSignature` and `BrandJsonJwksResolver` instead of per-counterparty `jwks_uri` pre-configuration.

See `skills/build-seller-agent/SKILL.md` § Protocol-Wide Requirements and § Composing OAuth, signing, and idempotency for the fully wired reference agent.
