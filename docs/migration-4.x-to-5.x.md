# Migrating from @adcp/client 4.x to 5.x

`@adcp/client` 5.x tracks **AdCP 3.0 GA**. Most 4.x users will skip the
intermediate 5.x releases entirely and land on 5.10 in one step — so this
guide centres on the two arcs that actually matter: the framework reshape
(Parts 1–3, originally 5.0 → 5.2) and the schema tightening + strict
defaults that finish the 3.0 GA alignment (Part 4, 5.10). Part 5
collects the 5.3–5.9 changes as **adoption-gated** items — read the
subsystem that applies to you, skip the rest.

Breaking items are marked **BREAKING**. Everything else is additive but
recommended. The migration checklist at the bottom is the condensed
version you can paste into a ticket.

> **A2A callers, read §5e before you ship.** The 5.9 A2A multi-turn
> session-continuity fix changed which response-metadata field carries
> the conversation id; a 4.x caller upgrading straight to 5.10 will
> silently drift without the §5e update. It's the one interim-release
> item that applies regardless of which subsystems you've adopted.

> Prior doc consolidations: this file supersedes `migration-4.30-to-5.2.md`
> and `migration-5.3-to-5.4.md`.

---

## Wire interop — which 5.x clients talk to which AdCP server versions

Library code surface (what you write in TypeScript) changes on almost every
minor release. The **wire protocol** — the JSON that crosses between a buyer
and a seller — is a different thing, and its compat story is narrower than
the TS churn suggests. If the library version you're on declares
compatibility with an AdCP version (see `COMPATIBLE_ADCP_VERSIONS` in
`@adcp/client/version`), cross-version traffic is supported at the wire
level with the caveats below.

**As of 5.10 (AdCP 3.0 GA):**

| From            | To              | Wire-compatible? | Notes                                                                                                    |
| --------------- | --------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| GA client       | GA server       | ✅               | Default path.                                                                                            |
| GA client       | beta.3 server   | ⚠️ two caveats   | (1) beta.3 assets lack the required `asset_type` discriminator; a strict GA client rejects them. (2) GA clients send new top-level required fields (`buying_mode` on `get_products`, `idempotency_key` on every mutating request) that beta.3's `additionalProperties: true` tolerates — but if your beta.3 server has its own strict layer, it will reject. Mitigations: `validation: { requests: 'warn' }` on the GA client; ensure the beta.3 server doesn't strict-validate unknown top-levels. |
| beta.3 client   | GA server       | ⚠️ one caveat    | GA `get_products_request.json` requires `buying_mode` and every mutating GA request requires `idempotency_key`. A beta.3 client that doesn't send them will be rejected by a GA server running strict request validation (5.10 default in dev/test). Run the GA server with `validation: { requests: 'warn' }` — or upgrade the client. beta.3 clients never sent `refine[]`, `report_plan_outcome`, `acquire_rights`, etc., so those paths don't dispatch. |
| rc.1/rc.2 client| GA server       | ⚠️ may break     | rc.1/rc.2 clients constructed `refine[]` entries as `{id, action}` — GA rejects because each `oneOf` arm is `additionalProperties: false`. rc.1/rc.2 is not in `COMPATIBLE_ADCP_VERSIONS`; upgrade the client.                              |
| GA server       | rc.1/rc.2 client| ⚠️ may break     | GA `refinement_applied[]` entries carry `product_id`/`proposal_id`; rc clients reading `.id` see `undefined`.                     |

**Checking interop yourself.** `npm run schema-diff` compares the current
`schemas/cache/latest/` against the snapshot captured on the previous
`npm run sync-schemas` run (`schemas/cache/latest.previous/`). The output
groups wire-level changes by kind (renames, newly-required fields,
additionalProperties tightened, oneOf-arm count changes) so you can see
which changes actually touch the JSON on the wire, rather than being pure
TypeScript narrowing.

---

## Part 1 — Framework shape (5.0.0)

_Applies to everyone upgrading from 4.x — the builder-based server API is the big break._

### 1a. **BREAKING** — `TaskResult` is a discriminated union

Failed tasks now use `status: 'failed'`, not `status: 'completed'`. MCP
`isError` responses preserve structured data (`adcp_error`, `context`,
`ext`) instead of throwing at the client.

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
  const err = result.adcp_error;
  if (result.isRetryable()) {
    await sleep(result.getRetryDelay());
    // retry
  }
}
```

New convenience accessors on `TaskResult`: `adcpError`, `correlationId`,
`retryAfterMs`, `isRetryable()`, `getRetryDelay()`.

### 1b. Framework — use `createAdcpServer` instead of `createTaskCapableServer` + `server.tool()`

4.x skill code used the low-level pattern. 5.0 shipped the declarative
builder. Migrate.

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
      return { products: [...], sandbox: true };   // response builder auto-applied
    },
  },
}));
```

`createAdcpServer` auto-generates `get_adcp_capabilities`, auto-applies
response builders, auto-echoes `context`/`ext`, and wires account
resolution. The `createTaskCapableServer` path still works for custom
tools but shouldn't be your default.

### 1c. New server-side response helpers

- `mediaBuyResponse(data)` — auto-defaults `revision`, `confirmed_at`, `valid_actions` based on `status`.
- `validActionsForStatus(status)` — map a MediaBuy status to the legal `valid_actions` list.
- `cancelMediaBuyResponse({...})` — requires cancellation metadata.

Applied automatically when you use `createAdcpServer` with a `mediaBuy`
domain group. Call them directly only for custom wrappers.

### 1d. Creative asset record shape

`creatives[].assets` is now `Record<asset_id, Asset>` (keyed object), not
an array.

**Before:**

```typescript
creatives: [{ creative_id: 'c1', assets: [{ asset_id: 'hero', asset_type: 'image', url: '...' }] }]
```

**After:**

```typescript
creatives: [{ creative_id: 'c1', assets: { hero: { asset_type: 'image', url: '...' } } }]
```

### 1e. Brand-rights is a first-class server domain

Collapse manual `server.tool()` registration into `createAdcpServer({
brandRights: { getBrandIdentity, getRights, acquireRights } })`. Three
tools have schemas; `update_rights` and `creative_approval` don't
(tracked upstream at adcontextprotocol/adcp#2253).

## Part 2 — Exports and tooling cleanup (5.1.0)

_Skim only if your 4.x code imported `@adcp/client/storyboards/*` or used `ComplyOptions.platform_type` / the `--platform-type` CLI flag._

### 2a. **BREAKING** — Storyboards no longer bundled in npm

The `storyboards/` directory was removed from the published package. Pull
the compliance tarball via `npm run sync-schemas` — it fetches
`/protocol/{version}.tgz` from adcontextprotocol.org, verifies sha256,
and extracts to `schemas/cache/{version}/` + `compliance/cache/{version}/`.
The cache ships with npm on first install.

If you had code referencing `@adcp/client/storyboards/*` directly, switch
to the new compliance-cache testing exports:

```typescript
import {
  resolveStoryboardsForCapabilities,
  loadComplianceIndex,
  getComplianceCacheDir,
} from '@adcp/client/testing';
```

Storyboard selection is now driven by the agent's `get_adcp_capabilities`:
`supported_protocols` resolves to domain baselines; `specialisms` resolves
to specialism bundles. The runner fails closed on unknown specialisms.

### 2b. **BREAKING** — Removed exports and CLI flags

| Removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Replacement                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ComplyOptions.platform_type`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Capability-driven selection (drop the option, or pass `storyboards: [id]`)                                                                                                                                                                                                                                                                                                                        |
| `ComplianceResult.platform_coherence` / `expected_tracks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Gone                                                                                                                                                                                                                                                                                                                                                                                              |
| `ComplianceSummary.tracks_expected`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Gone                                                                                                                                                                                                                                                                                                                                                                                              |
| `PlatformType`, `SalesPlatformType`, `CreativeAgentType`, `SponsoredIntelligenceType`, `AINativePlatformType`, `PlatformProfile`, `PlatformCoherenceResult`, `CoherenceFinding`, `InventoryModel`, `PricingModel`                                                                                                                                                                                                                                                                                                                | Type exports — just delete usages                                                                                                                                                                                                                                                                                                                                                                 |
| `getPlatformProfile`, `getAllPlatformTypes`, `getPlatformTypesWithLabels`, `PLATFORM_STORYBOARDS`, `getStoryboardIdsForPlatform`, `extractScenariosFromStoryboard`, `filterToKnownScenarios`, `loadBundledStoryboards`, `loadBundledScenarios`, `getStoryboardById`, `getScenarioById`, `getStoryboardsForPlatformType`, `getComplianceStoryboards`, `getApplicableComplianceStoryboards`, `listStoryboards`                                                                                                                      | Helper exports — replace with `resolveStoryboardsForCapabilities` + `loadBundleStoryboards` + `getComplianceStoryboardById` from `@adcp/client/testing`                                                                                                                                                                                                                                           |
| CLI: `adcp storyboard list --platform-type`, `adcp storyboard run --platform-type`, `adcp storyboard run --list-platform-types`                                                                                                                                                                                                                                                                                                                                                                                                 | CLI: `adcp storyboard run <agent>` (capability-driven), or `adcp storyboard run <agent> --file <path.yaml>` for one-off runs                                                                                                                                                                                                                                                                      |

### 2c. Optimistic concurrency on `AdcpStateStore` (additive)

`putIfMatch(collection, id, data, expectedVersion)`,
`getWithVersion(collection, id)`, and `patchWithRetry(store, collection, id,
updateFn, options?)` are new. Both `InMemoryStateStore` and
`PostgresStateStore` track a monotonic `version` per row. Postgres
migration is non-breaking — `ADD COLUMN IF NOT EXISTS version INTEGER
DEFAULT 1`, no data rewrite.

## Part 3 — AdCP 3.0 GA alignment (5.2.0)

_Applies to everyone — this is the wire-level 3.0 GA transition: governance, idempotency, webhook shape, auth middleware._

### 3a. **BREAKING** — `authority_level` split into two fields

The governance `Plan.authority_level` enum is removed.

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

Handlers that branched on `plan.authority_level === 'human_required'` now
branch on `plan.human_review_required`. Human review is signalled as
`status: 'denied'` + a `HUMAN_REVIEW_REQUIRED` finding at `severity:
'critical'`. The old `'escalated'` status was dropped; the `check_governance`
response enum is exactly `approved | denied | conditions`.

### 3b. **BREAKING** — `inventory-lists` specialism renamed to `property-lists`

```diff
-  specialisms: ['inventory-lists']
+  specialisms: ['property-lists']
```

Tool names were already `property_list`. New `collection-lists` specialism
covers program-level brand safety via IMDb/Gracenote/EIDR IDs — genuinely
new, not a rename.

### 3c. **BREAKING** — Specialism yaml field `domain:` → `protocol:`

If any tooling reads `compliance/cache/*/specialisms/<id>/index.yaml`
directly, update consumers to read `protocol:` instead of `domain:`.

### 3d. **BREAKING** — `audience-sync` reclassified from governance to media-buy

Move handlers from the governance agent's `governance` domain group to the
seller skill's `accounts` + `eventTracking` domain groups. `sync_audiences`
is overloaded — discovery (empty audiences array), add
(`a.add: [{hashed_email}|{hashed_phone}]`), delete (`a.delete: true`). There
is no separate `delete_audience` tool.

### 3e. **BREAKING** — `idempotency_key` required on every mutating request

The SDK rejects mutating requests without `idempotency_key` as
`INVALID_REQUEST` **before your handler runs**. Wire
`createIdempotencyStore` into `createAdcpServer`:

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

Authoritative list: **`MUTATING_TASKS`** exported from `@adcp/client`
(and derived at runtime in `src/lib/utils/idempotency.ts`). A partial
hand-written list here would drift as soon as the spec adds a new
mutating task. Import it if you need to branch on it programmatically:

```typescript
import { MUTATING_TASKS } from '@adcp/client';
if (MUTATING_TASKS.has(toolName)) { /* … */ }
```

The framework handles replay detection, payload-hash conflict
(`IDEMPOTENCY_CONFLICT`), TTL expiry (`IDEMPOTENCY_EXPIRED`), in-flight
parallelism (`SERVICE_UNAVAILABLE` + `retry_after: 1`), and `replayed: true`
injection. Remove manual `ctx.store.get('idempotency', key)` patterns.

### 3f. **BREAKING** — `create_media_buy` with IO approval returns a task envelope

Guaranteed buys that require IO signing are modelled at the **MCP task
layer**, not with a `pending_approval` MediaBuy status. Return a task
envelope — no `media_buy_id`, no `packages`, not yet.

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

When the IO is signed, emit the final `create_media_buy` result to the
buyer's `push_notification_config.url` via `ctx.emitWebhook` (see 3i) or
the next `tasks/get` poll.

**Buyer-side TS update**: `CreateMediaBuyResponse` union now includes a
`CreateMediaBuySubmitted` branch. Exhaustive discriminations need to
handle it.

### 3g. Server auth middleware (additive; required for compliance)

An agent that accepts unauthenticated requests fails the universal
`security_baseline` storyboard. Wire one of the new helpers:

```typescript
import { serve } from '@adcp/client';
import { verifyApiKey, verifyBearer, anyOf } from '@adcp/client/server';

serve(createAgent, {
  publicUrl: 'https://seller.example.com/mcp',
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

`verifyApiKey` / `verifyBearer` / `anyOf` are exported from
`@adcp/client/server`, not the root barrel.

### 3h. **BREAKING** — Webhook payloads now carry `idempotency_key`

Every webhook payload now includes a required `idempotency_key` string
(pattern `^[A-Za-z0-9_.:-]{16,255}$`). One payload was renamed:

```diff
-  RevocationNotification.notification_id: string
+  RevocationNotification.idempotency_key: string
```

Receivers must dedupe by `idempotency_key` scoped to the authenticated
sender identity. The SDK does this for you if you wire `webhookDedup`
(see 3j).

### 3i. Webhook emitter + `ctx.emitWebhook` (new, strongly recommended)

```typescript
import { createAdcpServer, serve } from '@adcp/client';

serve(() => createAdcpServer({
  name, version,
  webhooks: {
    signerKey: { keyid: 'publisher-kid-2026', alg: 'ed25519', privateKey: /* JWK with d */ },
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

The emitter handles RFC 9421 signing, stable `idempotency_key` per
`operation_id`, compact JSON serialization, retry with exponential
backoff + jitter on 5xx/429, and terminal handling of
`WWW-Authenticate: Signature error="webhook_signature_*"` responses.

### 3j. Receiver-side webhook dedup (new)

```typescript
import { AdCPClient } from '@adcp/client';
import { memoryBackend } from '@adcp/client/server';

const client = new AdCPClient(agents, {
  webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
  webhookSecret: process.env.WEBHOOK_SECRET,
  handlers: {
    webhookDedup: { backend: memoryBackend(), ttlSeconds: 86400 },
    onCreateMediaBuyStatusChange: async (result, metadata) => { /* first delivery only */ },
  },
});
```

**Breaking for strict TS**: `Activity.type` gains `'webhook_duplicate'`.

### 3k. **DEPRECATED** — `PushNotificationConfig.authentication`

`PushNotificationConfig.authentication` is now optional and deprecated.
Omit it to opt into the RFC 9421 webhook profile. Bearer and HMAC-SHA256
remain for legacy buyers (see 5.10 § Webhook HMAC legacy deprecation).

### 3l. Webhook signing: receiver-side verifier (new, opt-in)

```typescript
import {
  verifyWebhookSignature,
  BrandJsonJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} from '@adcp/client/signing/server';

const jwks = new BrandJsonJwksResolver('https://publisher.example/.well-known/brand.json', {
  agentType: 'sales',
});

await verifyWebhookSignature(request, {
  jwks,
  replayStore: new InMemoryReplayStore(),
  revocationStore: new InMemoryRevocationStore({ /* revoked_kids, revoked_jtis */ }),
});
```

Throws `WebhookSignatureError` with a typed `webhook_signature_*` code on
rejection. Match these codes in your 401 `WWW-Authenticate: Signature
error=…` response — the conformance runner grades on the exact code.

### 3m. Storyboard runner webhook conformance (new)

`expect_webhook`, `expect_webhook_retry_keys_stable`, and
`expect_webhook_signature_valid` are new pseudo-tasks. Configure
`runStoryboard({ webhook_receiver, webhook_signing })` and use
`{{runner.webhook_url:<step_id>}}` to inject ephemeral URLs into
`push_notification_config.url`.

### 3n. RFC 9421 request signing (additive; opt-in)

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

Server-side wiring: see `skills/build-seller-agent/SKILL.md` § signed-requests.

## Part 4 — AdCP 3.0 GA schema tightening + library defaults (5.10.0)

_Applies to everyone — the generated types shift under your handlers and dev-mode response validation goes strict._

The 5.10 release carries the second half of the 3.0 GA alignment — the
generated schemas catch up to the spec's latest tightening, and the
library's validation/typing defaults get strict enough to surface drift
at handler-dev time instead of at wire-level failure in a downstream
consumer.

### 4a. Generated schemas — the actual protocol changes

- **Asset types (`ImageAsset`, `VideoAsset`, `VAST`, `DAAST`, `HTMLAsset`,
  `JavaScriptAsset`, `CSSAsset`, `MarkdownAsset`, `WebhookAsset`,
  `TextAsset`, `URLAsset`, `AudioAsset`, `BriefAsset`, `CatalogAsset`)
  gain a required `asset_type` literal discriminator** (`"image"`,
  `"vast"`, `"daast"`, etc.). Handlers that emit assets must populate it.
  This is the only wire-level breaker against beta.3 — see the wire
  interop table at the top of this doc. Use the new typed builders from
  `@adcp/client` to inject the discriminator without the boilerplate:
  `imageAsset({ url, width, height })` → `{ url, width, height,
  asset_type: 'image' }`. Helpers are available for every asset type
  (`imageAsset`, `videoAsset`, `audioAsset`, `textAsset`, `urlAsset`,
  `htmlAsset`, `javascriptAsset`, `cssAsset`, `markdownAsset`,
  `webhookAsset`), plus the grouped `Asset` namespace
  (`Asset.image({...})`) over the same functions.
- **`GetProductsRequest.refine[]`** — `id` field renamed to `product_id`
  (product scope) or `proposal_id` (proposal scope); `action` is now
  optional (defaults to `'include'`). New-in-GA surface; beta.3 clients
  never sent it.
- **`GetProductsResponse.refinement_applied[]`** — flat object replaced
  by a `oneOf` discriminated union on `scope`. Each arm carries
  `product_id`/`proposal_id` instead of a shared `id`. New-in-GA surface.
- **VAST/DAAST restructure** — common fields (`vast_version`,
  `tracking_events`, `vpaid_enabled`, `duration_ms`, `captions_url`,
  `audio_description_url`) hoisted from inside each `oneOf` arm to the
  base object. The hoisted fields themselves are wire-compatible; the
  only new required field is `asset_type`, same break as the other
  asset types above.
- **Governance plan requests** (`ReportPlanOutcomeRequest`,
  `GetPlanAuditLogsRequest`, `CheckGovernanceRequest`) — tightened to
  reject redundant `account` fields alongside `plan_id` (or `plan_ids`
  on `GetPlanAuditLogsRequest`, which takes the plural). New-in-GA.

Run `npm run schema-diff` after each `npm run sync-schemas` to see
wire-level deltas grouped by kind (renames, newly-required,
`additionalProperties` tightened, `oneOf` arm count changes).

### 4b. **BREAKING for `tsc`** — `AdcpToolMap` brand-rights + `DomainHandler` return types

`acquire_rights`, `get_rights`, and `get_brand_identity` had
`result: Record<string, unknown>`. Replaced with the generated types:

- `acquire_rights` → `AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected`
- `get_rights` → `GetRightsSuccess`
- `get_brand_identity` → `GetBrandIdentitySuccess`

`DomainHandler` return type previously included `| Record<string, unknown>`
as an escape hatch. Now just `AdcpToolMap[K]['result'] | McpToolResponse`,
so drift fails at compile time. `adcpError(...)` still works — it
returns `McpToolResponse`.

Handlers returning plain object literals without the full success shape
now fail `tsc`:

```
Type '{ products: [{ product_id: 'p1' }] }' is not assignable to type
'McpToolResponse | GetProductsResponse'.
  Property 'reporting_capabilities' is missing in type '{ product_id: 'p1' }'
  but required in type 'Product'.
```

Fix by filling required fields (use `DEFAULT_REPORTING_CAPABILITIES` for
`Product.reporting_capabilities` if you don't have seller-specific
policy), or wrap with a response builder (`productsResponse`,
`acquireRightsResponse`) that accepts typed inputs.

### 4c. **BREAKING for dev/test** — Response validation defaults to `'strict'`

`createAdcpServer({ validation: { responses } })` now defaults to
`'strict'` when `NODE_ENV !== 'production'`. Handler-returned schema
drift fails with `VALIDATION_ERROR` (field path in `details.issues`)
instead of logging a warning you can silently ignore.

Production stays `'off'`. Pass `validation: { responses: 'warn' }` to
restore the previous dev behavior; `'off'` opts out entirely.

Handler tests using sparse fixtures (e.g. `{ products: [{ product_id:
'p1' }] }`) will start returning `VALIDATION_ERROR`. Either fill in
required fields or set `validation: { responses: 'off' }` on the test
server. **Node's test runner does not set `NODE_ENV`, so `node --test`
suites fall into the dev/test bucket and start validating responses**
— this is intentional.

`VALIDATION_ERROR.details.issues[].schemaPath` is now gated behind
`exposeErrorDetails` (same policy as `SERVICE_UNAVAILABLE.details.reason`).
Production responses no longer leak `#/oneOf/<n>/properties/...` paths
that fingerprint internal `oneOf` branch selection.

### 4d. Request validation defaults to `'warn'` outside production

Mirrors the asymmetric default for `responses`. Each incoming request
that doesn't match the bundled AdCP request schema logs `Schema
validation warning (request)` with the tool name and field pointer.
Nothing is rejected. Pass `validation: { requests: 'off' }` on the test
server to opt out.

### 4e. `exposeErrorDetails` defaults to `true` outside production

`SERVICE_UNAVAILABLE.details.reason` and
`VALIDATION_ERROR.details.issues[].schemaPath` ship to callers in
dev/test/CI. Production stays opted out.

### 4f. `McpServer.tool()` → `registerTool()` migration

`createAdcpServer`, `comply_test_controller`, the governance-agent stub,
and `examples/error-compliant-server.ts` use the SDK's supported
`registerTool(name, config, handler)` form. Behavior is unchanged.

If your code registered tools directly via `server.tool(...)` against
the SDK, migrate to `server.registerTool(...)`. Framework-registered
tools deliberately do **not** wire `outputSchema` — the MCP SDK's
client-side `callTool` validates `structuredContent` against
`outputSchema` even on `isError` responses, which would fail every
`adcpError()` envelope. Until the SDK gates that check on `!isError`,
framework tools skip it. `customTools[*].outputSchema` may opt in
explicitly.

### 4g. OAuth 2.0 Client Credentials support (additive)

CLI:

```bash
adcp storyboard run --agent https://agent.example.com \
  --oauth-client-id $ID --oauth-client-secret $SECRET \
  --oauth-token-url https://auth.example.com/token
```

Library:

```typescript
const client = new AdCPClient([{
  agent_id: 'seller',
  url: 'https://agent.example.com/mcp',
  auth: {
    type: 'oauth_client_credentials',
    credentials: {
      client_id: '$ENV:SELLER_CLIENT_ID',         // $ENV:VAR resolves at dispatch
      client_secret: '$ENV:SELLER_CLIENT_SECRET',
      token_url: 'https://auth.example.com/oauth/token',
      scopes: ['adcp.read', 'adcp.mutate'],
    },
  },
}]);
```

Tokens cache until the advertised `expires_in` minus a 60s skew. Failed
token fetches return `AUTH_UNAVAILABLE` without retrying.

### 4h. New default assertion — `status.monotonic`

Resource statuses observed across storyboard steps must transition only
along edges in the spec-published lifecycle graph. Catches regressions
like `active → pending_creatives` on a media_buy or `approved →
processing` on a creative asset that per-step validations can't detect.

Tracked lifecycles: `media_buy`, `creative` (asset lifecycle),
`creative_approval`, `account`, `si_session`, `catalog_item`, `proposal`.
Scope is `(resource_type, resource_id)` so independent resources don't
interfere. Unknown enum values reset the anchor without failing
(`response_schema` catches enum violations).

---

## Part 5 — Interim library polish (5.3 – 5.9)

_Applies selectively — read only the subsections whose subsystem you use, with one exception: **every A2A caller should read §5e** (breaking change to session-continuity semantics)._

Most 4.x upgraders will skip directly to 5.10 without riding the
intermediate releases. Nothing in 5.3–5.9 is a step-by-step migration
item — these are **subsystem adoption paths** and one breaking change
for A2A callers. Read only the subsections whose subsystem you actually
use.

### 5a. Server type surface (5.4)

`createAdcpServer()` now returns the opaque `AdcpServer` type (not the
SDK's `McpServer`). Annotate with `import type { AdcpServer } from
'@adcp/client'`. Test harnesses use `server.dispatchTestRequest({
method, params })` instead of `(server as any)._requestHandlers.get(...)`.

For tools outside `AdcpToolMap` (seller extensions, `creative_approval`,
`update_rights`), pass a `customTools` map:

```typescript
createAdcpServer({
  name: 'Publisher', version: '1.0.0',
  mediaBuy: { getProducts: async () => ({ products }) },
  customTools: {
    creative_approval: {
      description: 'Out-of-band creative approval.',
      inputSchema: { creative_id: z.string(), approved: z.boolean() },
      handler: async ({ creative_id, approved }) => ({
        content: [{ type: 'text', text: `creative ${creative_id} ${approved ? 'approved' : 'rejected'}` }],
        structuredContent: { creative_id, approved },
      }),
    },
  },
});
```

### 5b. Signed-requests authentication composition (5.5 – 5.6)

If you claim `signed-requests`:

- `verifySignatureAsAuthenticator` adapts `verifyRequestSignature` into
  an `Authenticator` composable with `anyOf(bearer, signature)` — lets
  a single endpoint accept either bearer credentials OR a valid RFC
  9421 signature.
- `requireSignatureWhenPresent(sig, fallback)` is presence-gated: if a
  signature header is present, the verifier runs and its result is
  final; otherwise fallback runs. **Use this, not `anyOf(bearer, sig)`**,
  for the specialism's negative vectors (`request_signature_revoked`,
  `request_signature_window_invalid`) to reject correctly even with a
  valid bearer also present. The composed authenticator is tagged
  `AUTH_PRESENCE_GATED`; `anyOf` throws at wire-up time if you try to
  nest it.

`capabilities.overrides` (5.5) lets you surface per-domain capability
fields the framework doesn't auto-derive — e.g.
`media_buy.execution.targeting.*`, `media_buy.audience_targeting.*`,
`compliance_testing.scenarios` — without reaching for `getSdkServer()`.

### 5c. Conformance runner wiring (5.7)

For agents mounted under Express:

```typescript
import { createExpressAdapter } from '@adcp/client/server';

const { rawBodyVerify, protectedResourceMiddleware, getUrl, resetHook } =
  createExpressAdapter({ mountPath: '/mcp', publicUrl, prm, server });
```

New subpath exports for conformance work:

- `@adcp/client/compliance-fixtures` — `COMPLIANCE_FIXTURES` +
  `seedComplianceFixtures(server)` for hardcoded storyboard IDs
  (`test-product`, `sports_ctv_q2`, `gov_acme_q2_2027`, etc.).
- `@adcp/client/schemas` — generated Zod request schemas,
  `TOOL_INPUT_SHAPES`, and `customToolFor(name, description, shape, handler)`.

`AdcpServer.compliance.reset({ force? })` drops session state and the
idempotency cache between storyboards. Refuses to run in production-like
deployments unless `force: true`.

`requireAuthenticatedOrSigned({ signature, fallback, requiredFor,
resolveOperation })` bundles presence-gated signature composition with
`required_for` enforcement.

`VersionUnsupportedError` has a typed `reason` (`'version' | 'idempotency'
| 'synthetic'`). `client.requireV3()` now corroborates the v3 claim and
rejects synthetic capabilities; `requireV3ForMutations: true` gates
mutating calls before dispatch.

### 5d. Compliance test controller (5.8)

If you ship a `comply_test_controller` tool, use `createComplyController`
instead of hand-registering:

```typescript
import { createComplyController } from '@adcp/client/testing';

const controller = createComplyController({
  sandboxGate: () => process.env.ADCP_SANDBOX === '1',
  seed: {
    product: ({ product_id, fixture }) => productRepo.upsert(product_id, fixture),
    creative: ({ creative_id, fixture }) => creativeRepo.upsert(creative_id, fixture),
  },
  force: {
    creative_status: ({ creative_id, status }) => creativeRepo.transition(creative_id, status),
  },
});
controller.register(server);
```

Owns scenario dispatch, param validation, typed error envelopes
(`UNKNOWN_SCENARIO`, `INVALID_PARAMS`, `FORBIDDEN`), MCP response
shaping, and seed idempotency. Gate on something **the server**
controls — never trust caller-supplied fields like `input.ext`.

`adcp storyboard run` gains `--invariants <module[,module...]>`, which
dynamic-imports each specifier before the runner resolves
`storyboard.invariants` — populates the assertion registry without
editing the CLI.

### 5e. **BREAKING for A2A multi-turn callers** — session continuity fix (5.9)

If you use A2A — especially HITL flows or multi-turn conversations —
read this. `callA2ATool` previously never put `contextId`/`taskId` on
the Message envelope and `AgentClient` stored `result.metadata.taskId`
into `currentContextId`. The field meant to carry the conversation id
was actually carrying a per-task correlation id; multi-turn A2A
silently fell back to new-session-every-call.

**Public API (AgentClient):**

```typescript
client.getContextId();          // read retained contextId
client.getPendingTaskId();      // read pending server taskId (HITL resume)
client.resetContext();          // wipe session state
client.resetContext(id);        // rehydrate persisted contextId across process restart
```

Callers who were reading `result.metadata.taskId` expecting to see
their caller-supplied `contextId` should now read
`result.metadata.contextId`. One `AgentClient` per conversation —
sharing interleaves session ids.

### 5f. Dispatcher auto-unwraps thrown `adcpError` envelopes (5.9)

Handlers that `throw adcpError(...)` instead of `return`-ing it used to
surface as `SERVICE_UNAVAILABLE: Tool X handler threw: [object Object]`.
The dispatcher now returns the envelope directly, preserving the typed
code. A `logger.warn` fires so agent authors see they should switch to
`return`. Idempotency claims are released on unwrap.

### 5g. Typed `CapabilityResolutionError` (5.9)

```typescript
import { CapabilityResolutionError } from '@adcp/client/testing';

try { /* resolveStoryboardsForCapabilities(...) */ }
catch (err) {
  if (err instanceof CapabilityResolutionError) {
    // err.code: 'specialism_missing_bundle' | 'specialism_parent_protocol_missing'
    // err.specialism, err.protocol, err.details
  }
}
```

Callers no longer need to regex error messages to branch on
agent-config faults vs system errors.

### 5h. New default assertion — `governance.denial_blocks_mutation` (5.9)

Once a plan receives a denial signal (`GOVERNANCE_DENIED`,
`CAMPAIGN_SUSPENDED`, `PERMISSION_DENIED`, `POLICY_VIOLATION`,
`TERMS_REJECTED`, `COMPLIANCE_UNSATISFIED`, or `check_governance`
returning `denied`), no subsequent step in the run may acquire a
resource for that plan. Plan-scoped via `plan_id`; sticky within a run.

`storyboard/index.ts` now side-imports `default-invariants` so direct
`runStoryboard` callers pick up all built-ins. Consumers who want to
replace defaults: `clearAssertionRegistry()` then re-register.

### 5i. Skill examples tightened against spec drift (5.8)

Concrete wire-level fixes worth mirroring in your own handlers:

- Use `DEFAULT_REPORTING_CAPABILITIES` for `Product.reporting_capabilities`
  instead of hand-rolled literals.
- `create_media_buy` handlers must persist top-level `currency` +
  `total_budget` so subsequent `get_media_buys` responses carry both.
- `update_media_buy.affected_packages` is `Package[]`, not `string[]`.
- `list_creative_formats.renders[]` requires `role` plus exactly one of
  `dimensions` (object) or `parameters_from_format_id: true`.
- Don't echo `context: args.context` in handler returns — the framework
  auto-injects the request context; a non-object string fails validation.

### Superseded / dropped sections

Four items that appeared in interim release notes aren't migration
steps for a 4.x upgrader and are omitted here:

- **`AdcpServer` was pre-release `McpServer`** (5.4) — only breaks if
  you were typing against a 5.3 snapshot; nobody was.
- **`structuredContent` became optional** (5.4) — pre-release
  ergonomics; 4.x users never had the stub.
- **`SingleAgentClient.validateRequest` dropped `strict()`** (5.4) —
  internal client behavior; no user-visible change.
- **`multi-pass` storyboard strategy** (5.6) — opt-in replica
  coverage, not a migration item.

---

## v2 sunset

AdCP v2 went unsupported on 2026-04-20 as part of the 3.0 GA cutover
([adcp#2220](https://github.com/adcontextprotocol/adcp/issues/2220)). The
client still executes v2 code paths — no functional break — but emits a
one-time `console.warn` the first time a client instance sees v2
capabilities from an agent. Suppress with `ADCP_ALLOW_V2=1` or `adcp
--allow-v2` if you're knowingly running against a legacy holdout.
Synthetic capabilities don't fire the warning.

## Webhook HMAC legacy deprecation

**What.** The `type: 'hmac_sha256'` variant of `WebhookAuthentication` on
outbound webhook emission — emits `x-adcp-timestamp` + `x-adcp-signature:
sha256=...` over `${ts}.${body_bytes}`.

**Why deprecated.** The spec-current webhook authentication is an RFC 9421
signature with `adcp_use: "webhook-signing"` JWKs (adcp#2423). HMAC
predates 9421 and is kept only for buyers who registered
`push_notification_config.authentication.credentials` before the 9421
rollout.

**Status in 5.x.** Supported, no behavior change. The emitter logs a
one-time `console.warn` per process on first HMAC emission. Suppress with
`ADCP_SUPPRESS_HMAC_WARNING=1` or
`createWebhookEmitter({ suppressLegacyWarnings: true })`.

**Migration.** Switch emitters to the default 9421 path (omit
`authentication` entirely, or pass `null`). Buyers verify with
`verifyWebhookSignature` using a `BrandJsonJwksResolver` or pre-configured
JWKS URL.

---

## Migration checklist

Parts 1–4 are the migration. Part 5 items are adoption-gated.

### Part 1 — Framework shape (5.0)

- [ ] Replace `createTaskCapableServer` + `server.tool(...)` with `createAdcpServer({ ...domain groups... })`.
- [ ] Switch `TaskResult` branches from `status === 'completed' && adcp_error` to `status === 'failed'` + accessors.
- [ ] Update any `creatives[].assets` array payloads to keyed-object form.
- [ ] If you had custom `brandRights` tool registration, collapse to `createAdcpServer({ brandRights })`.

### Part 2 — Exports (5.1)

- [ ] Delete `ComplyOptions.platform_type` callers and `PlatformType`/`PlatformProfile`/`getPlatformProfile` imports.
- [ ] Replace CLI `--platform-type` usage with capability-driven runs or `--file <path.yaml>`.
- [ ] Switch storyboard-file imports to `@adcp/client/testing` helpers.

### Part 3 — AdCP 3.0 GA protocol alignment (5.2)

- [ ] Replace `plan.authority_level` with `plan.budget.reallocation_threshold` / `reallocation_unlimited` + `plan.human_review_required`.
- [ ] Rename `inventory-lists` → `property-lists` in `get_adcp_capabilities`.
- [ ] Update yaml consumers from `domain:` → `protocol:`.
- [ ] Move `audience-sync` handlers to `accounts` / `eventTracking`.
- [ ] Wire `createIdempotencyStore` into `createAdcpServer({ idempotency })`. Remove manual `ctx.store.get('idempotency', …)` code.
- [ ] Wire `serve({ authenticate, publicUrl, protectedResource })`.
- [ ] Return `taskToolResponse({ status: 'submitted', task_id, message })` from `create_media_buy` for IO-signing flows.
- [ ] Handle the new `'submitted'` branch of `CreateMediaBuyResponse` in exhaustive client-side discrimination.
- [ ] Rename `RevocationNotification.notification_id` → `idempotency_key` on revocation webhooks.
- [ ] Wire `createAdcpServer({ webhooks: { signerKey } })` + `ctx.emitWebhook`.
- [ ] Add `handlers: { webhookDedup: { backend: memoryBackend() } }` to `AdCPClient`. Handle `Activity.type === 'webhook_duplicate'`.

### Part 4 — AdCP 3.0 GA schema tightening + library defaults (5.10)

- [ ] Populate `asset_type` on every asset literal your handlers emit (`"image"`, `"video"`, `"vast"`, `"daast"`, …). Prefer the typed builders — `imageAsset(...)`, `videoAsset(...)`, etc. from `@adcp/client` — over hand-rolled literals; they inject the discriminator as a write-last property so a TS escape-hatch cast can't overwrite it.
- [ ] Rename `refine[].id` → `refine[].product_id` / `refine[].proposal_id` on the scope-matching arm.
- [ ] Run `tsc --noEmit`; fix every brand-rights handler whose return type is no longer assignable to the concrete generated types (`AcquireRights*`, `GetRightsSuccess`, `GetBrandIdentitySuccess`).
- [ ] Expect dev/test response validation to fail on sparse fixtures — fill in required fields or set `validation: { responses: 'off' }` on test servers.
- [ ] If you registered tools directly via `McpServer.tool(...)`, migrate to `McpServer.registerTool(...)`.
- [ ] (Optional) Wire OAuth 2.0 client credentials via `auth: { type: 'oauth_client_credentials', credentials: {...} }` where sellers require it.

### Part 5 — Adoption-gated (5.3–5.9)

Only the items whose subsystem you actually use.

- [ ] **A2A multi-turn callers** — one `AgentClient` per conversation (or call `resetContext()` per turn). Read `result.metadata.contextId` instead of `result.metadata.taskId` for the server-returned session id.
- [ ] **`signed-requests` adopters** — replace `anyOf(bearer, sig)` with `requireSignatureWhenPresent(sig, anyOf(bearer, apiKey))`.
- [ ] **Express-mounted agents** — use `createExpressAdapter({ mountPath, publicUrl, prm, server })` for the raw-body capture + PRM + URL reconstruction + reset hook.
- [ ] **Test-harness authors** — swap `(server as any)._requestHandlers.get(...)` for `server.dispatchTestRequest(...)`. Annotate `createAdcpServer()` return as `AdcpServer`, not `McpServer`.
- [ ] **`comply_test_controller` publishers** — use `createComplyController({...}).register(server)` instead of hand-registering.
- [ ] **Storyboard runners** — seed with `seedComplianceFixtures(server)`; wire `AdcpServer.compliance.reset()` on your reset hook; handle `CapabilityResolutionError` by `err.code` rather than regexing messages.

### Tooling to adopt

- [ ] Run `npm run schema-diff` after each `npm run sync-schemas` to see wire-level deltas before they bite you downstream.

See `skills/build-seller-agent/SKILL.md` § Protocol-Wide Requirements and
§ Composing OAuth, signing, and idempotency for the fully wired reference
agent.
