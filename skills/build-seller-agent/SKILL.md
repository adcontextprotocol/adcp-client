---
name: build-seller-agent
description: Use when building an AdCP seller agent — a publisher, SSP, or retail media network that sells advertising inventory to buyer agents.
---

# Build a Seller Agent

## Overview

A seller agent receives briefs from buyers, returns products with pricing, accepts media buys, manages creatives, and reports delivery. The business model — what you sell, how you price it, and whether humans approve deals — shapes every implementation decision. Determine that first.

## When to Use

- User wants to build an agent that sells ad inventory
- User mentions publisher, SSP, retail media, or media network in the context of AdCP
- User references `get_products`, `create_media_buy`, or the media buy protocol

**Not this skill:**

- Buying ad inventory → that's a buyer/DSP agent (see `docs/getting-started.md`)
- Serving audience segments → `skills/build-signals-agent/`
- Rendering creatives from briefs → that's a creative agent

## <a name="the-baseline-what-every-sales--agent-must-implement"></a>The baseline: what every sales-\* agent MUST implement

Every sales-_ specialism (including `sales-social`, `sales-broadcast-tv`, `sales-retail-media`, `sales-catalog-driven`, etc.) is **additive on top of this baseline**. If you claim any `sales-_` specialism, you implement these tools regardless of the specialism-specific deltas below.

**Required tools** (tested by the `media_buy_seller` storyboard bundle at `compliance/cache/3.0.0/protocols/media-buy/`):

| Tool                     | Purpose                                                                            | `SalesPlatform` method   |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------ |
| `get_adcp_capabilities`  | Declare protocols + specialisms + features                                         | auto (framework)         |
| `sync_accounts`          | Advertiser onboarding, per-tenant account creation                                 | `accounts.upsert`        |
| `list_accounts`          | Account lookup by brand/operator; buyers listing their accounts on your platform   | `accounts.list`          |
| `get_products`           | Product catalog discovery from a brief; returns `{ products: [...] }`              | `sales.getProducts`      |
| `list_creative_formats`  | Formats your agent accepts                                                         | `sales.listCreativeFormats` |
| `create_media_buy`       | Accept a campaign with packages, budget, flight dates                              | `sales.createMediaBuy`   |
| `update_media_buy`       | Bid, budget, status, package mutations over the campaign lifecycle                 | `sales.updateMediaBuy`   |
| `get_media_buys`         | Read campaigns back with full state (status, budget, packages, targeting overlays) | `sales.getMediaBuys`     |
| `sync_creatives`         | Accept creative assets and return per-asset status                                 | `sales.syncCreatives`    |
| `list_creatives`         | Read the creative library back with pagination                                     | `sales.listCreatives`    |
| `get_media_buy_delivery` | Delivery + spend reporting with `reporting_period`, per-package billing rows       | `sales.getMediaBuyDelivery` |

> **`sales_guaranteed` minimum tool surface** — register ALL of these or storyboard scenarios will cascade-skip with `skip_reason: missing_tool`:
> `get_adcp_capabilities`, `sync_accounts`, `list_accounts`, `get_products`, `list_creative_formats`, `create_media_buy`, `update_media_buy`, `get_media_buys`, `sync_creatives`, `list_creatives`, `get_media_buy_delivery`

**Minimum platform skeleton** — every sales-\* seller starts here, then adds specialism-specific behavior on top:

```ts
import { createAdcpServerFromPlatform, type DecisioningPlatform, type SalesPlatform, type AccountStore } from '@adcp/sdk/server';

class MySeller implements DecisioningPlatform<{ networkId: string }, MyMeta> {
  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    pricingModels: ['cpm'] as const,
    channels: ['display'] as const,
    config: { networkId: 'NET_42' },
  };

  accounts: AccountStore<MyMeta> = {
    resolve: async (ref, ctx) => { /* … */ },
    upsert: async (params, ctx) => { /* … */ },
    list: async (params, ctx) => { /* … */ },
  };

  sales: SalesPlatform<MyMeta> = {
    getProducts: async (params, ctx) => { /* … */ },
    listCreativeFormats: async () => ({ formats: [...] }),
    createMediaBuy: async (params, ctx) => { /* … */ },
    updateMediaBuy: async (id, patch, ctx) => { /* … */ },
    getMediaBuys: async (params, ctx) => { /* … */ },
    syncCreatives: async (creatives, ctx) => { /* … */ },
    listCreatives: async (params, ctx) => { /* … */ },
    getMediaBuyDelivery: async (filter, ctx) => { /* … */ },
  };
}

const server = createAdcpServerFromPlatform(new MySeller(), {
  name: 'my-seller',
  version: '1.0.0',
});
```

The `createAdcpServerFromPlatform` path wraps a typed `DecisioningPlatform` with compile-time specialism enforcement (claim `sales-non-guaranteed`, miss a required `sales.*` method, fail compile), ctx_metadata round-trip + auto-hydration, idempotency-principal synthesis, status mappers, and webhook auto-emit. **Reach for the lower-level `createAdcpServer` from `@adcp/sdk/server/legacy/v5` only when you need fine control over individual handlers, are mid-migration from a v5 codebase, or have custom tools the platform interface doesn't yet model.**

If a specialism's storyboard doesn't exercise one of these tools, the tool is **not optional** — the storyboard is just focused elsewhere (e.g. `sales-social` covers audience sync + DPA + events; the media buy flow itself is covered by `sales-non-guaranteed` or `sales-guaranteed` which you also claim). See § [Tools and Required Response Shapes](#tools-and-required-response-shapes) below for the exact response shape each tool must return.

## Specialisms This Skill Covers

Your compliance obligations come from the specialisms you claim in `get_adcp_capabilities`. Each specialism has a storyboard bundle at `compliance/cache/latest/specialisms/<id>/` that the AAO compliance runner executes. Pick one or more.

**Specialisms are additive on top of [the baseline](#the-baseline-what-every-sales--agent-must-implement).** A specialism's storyboard exercises the ADDITIONAL behaviors it requires; it does not displace the baseline 11-tool surface above. If the storyboard skips a baseline tool (because that tool is already covered by `sales-non-guaranteed` / `sales-guaranteed`), that doesn't mean the tool is optional for your agent — it means the test is focused elsewhere. Check the storyboard's `agent.capabilities` — if it lists `sells_media` / `accepts_briefs`, the baseline still applies.

**Claim multiple specialisms.** A typical social seller claims `sales-non-guaranteed` + `sales-social`. A typical broadcast seller claims `sales-guaranteed` + `sales-broadcast-tv`. A typical social seller doing audience sync claims `sales-non-guaranteed` + `sales-social` + `audience-sync`.

| Specialism             | Status  | Delta from baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | See                                                        |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `sales-guaranteed`     | stable  | IO approval is **task-layer**, not MediaBuy-layer. Return a task envelope (MCP Tasks SDK) with `status: 'submitted'` + `task_id` + `message`. Do NOT return `media_buy_id` or `packages` yet — those land on the final artifact when the task completes. There is no `pending_approval` MediaBuy status.                                                                                                                                                                                                                                     | [§ sales-guaranteed](#specialism-sales-guaranteed)         |
| `sales-non-guaranteed` | stable  | Instant `status: 'active'` with `confirmed_at`; accept `bid_price` on packages; expose `update_media_buy` for bid/budget changes                                                                                                                                                                                                                                                                                                                                                                                                             | [§ sales-non-guaranteed](#specialism-sales-non-guaranteed) |
| `sales-broadcast-tv`   | stable  | Top-level `agency_estimate_number`; per-package `measurement_terms.billing_measurement`; Ad-ID `industry_identifiers` on creatives; `measurement_windows` (Live/C3/C7) on delivery                                                                                                                                                                                                                                                                                                                                                           | [§ sales-broadcast-tv](#specialism-sales-broadcast-tv)     |
| `sales-streaming-tv`   | preview | v3.1 placeholder (empty `phases`) — ship the baseline, declare `channels: ['ctv'] as const` on products                                                                                                                                                                                                                                                                                                                                                                                                                                      | Baseline only                                              |
| `sales-social`         | stable  | **Additive**: baseline `get_products` + `create_media_buy` still apply (Snap/Meta/TikTok all have product catalogs and campaigns). Adds `sync_audiences` (audience push), `sync_creatives` (native formats), `sync_catalogs` (dynamic product ads), `log_event` (conversion tracking), `get_account_financials` (prepaid-balance monitoring), and `sync_accounts` with `account_scope`/`payment_terms`/`setup` for advertiser onboarding. Declare `sales-social` **alongside** `sales-non-guaranteed` (or `-guaranteed`) — don't replace it. | [§ sales-social](#specialism-sales-social)                 |
| `sales-exchange`       | preview | v3.1 placeholder — target `sales-non-guaranteed` baseline; PMP / deal IDs / auction transparency pending                                                                                                                                                                                                                                                                                                                                                                                                                                     | Baseline only                                              |
| `sales-proposal-mode`  | stable  | `get_products` returns `proposals[]` with `budget_allocations`; handle `buying_mode: 'refine'`; accept via `create_media_buy` with `proposal_id` + `total_budget` and no `packages`                                                                                                                                                                                                                                                                                                                                                          | [§ sales-proposal-mode](#specialism-sales-proposal-mode)   |
| `audience-sync`        | stable  | Track: `audiences`. Implement `sync_audiences` (handles discovery, add, and delete) and `list_accounts`. Hashed identifiers (SHA-256 lowercased+trimmed). Match-rate telemetry on response.                                                                                                                                                                                                                                                                                                                                                  | [§ audience-sync](#specialism-audience-sync)               |
| `signed-requests`      | preview | RFC 9421 HTTP Signature verification on mutating requests. Advertise `request_signing.supported: true` in capabilities; graded against conformance vectors — positive vectors must produce non-4xx; negative vectors must return `401` with `WWW-Authenticate: Signature error="<code>"` matching the vector's `expected_outcome.error_code` byte-for-byte.                                                                                                                                                                                  | [§ signed-requests](#specialism-signed-requests)           |

**Not in this skill:** `sales-catalog-driven` and `sales-retail-media` (both in `skills/build-retail-media-agent/` — catalog-driven applies to restaurants, travel, and local commerce too, not only retail).

Specialism ID (kebab-case) = storyboard directory. The storyboard's `id:` field (snake_case, e.g. `media_buy_broadcast_seller`) is the category name, not the specialism name. One specialism can apply to multiple product lines — a seller with both CTV inventory and broadcast TV inventory can claim `sales-streaming-tv` and `sales-broadcast-tv` simultaneously.

## Protocol-Wide Requirements (AdCP 3.0 GA)

Three requirements apply to **every** production seller, regardless of which specialism you claim. Don't reinvent any of them — the SDK provides helpers for each.

### `idempotency_key` is required on every mutating request

`create_media_buy`, `update_media_buy`, `sync_accounts`, `sync_creatives`, `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `provide_performance_feedback` — every mutating call carries a client-supplied `idempotency_key`. Wire `createIdempotencyStore` into `createAdcpServerFromPlatform(platform, { idempotency })` and the framework handles replay detection, payload-hash conflict (`IDEMPOTENCY_CONFLICT`), expiry (`IDEMPOTENCY_EXPIRED`), and in-flight parallelism. Don't implement this in handler code. See [§ Idempotency](#idempotency) below for the full wire-up.

### Authentication is mandatory

An agent that accepts unauthenticated requests is non-compliant — the universal `security_baseline` storyboard enforces this. Wire `serve({ authenticate })` with `verifyApiKey`, `verifyBearer`, or `anyOf(...)` before you claim any specialism. See [§ Protecting your agent](#protecting-your-agent) below.

### Don't break when RFC 9421 Signature headers arrive

Even if you don't claim `signed-requests`, a buyer may send `Signature-Input` / `Signature` headers. Your MCP transport must pass the request through without rejecting it. If you do claim the specialism, verify per [§ signed-requests](#specialism-signed-requests) below.

### Resolve-then-authorize — uniform errors for not-found / not-yours

AdCP spec § error-handling MUSTs that you return **byte-equivalent responses** for "the id exists but the caller lacks access" vs "the id does not exist." Distinguishing the two leaks cross-tenant existence information — an attacker who learns that `mb_0x1234` returns `PERMISSION_DENIED` while `mb_0xabcd` returns `REFERENCE_NOT_FOUND` can enumerate every live id across every tenant you host.

The rule applies to every observable channel: `error.code` / `message` / `field` / `details`, HTTP status, A2A `task.status.state`, MCP `isError`, response headers (`ETag`, `Cache-Control`, rate-limit, CDN tags), webhook/audit dispatch, logs with tenant correlation, same work on both paths.

**How to get it right:**

- Both paths return `REFERENCE_NOT_FOUND` (or the domain-specific `*_NOT_FOUND` code). Never `PERMISSION_DENIED` or `FORBIDDEN` on an id lookup.
- Don't echo the probed id in `error.details` — or echo it in both paths identically.
- Route both paths through the same response constructor so headers (including `ETag`, `Cache-Control`) are set identically.
- Do the same work on both paths: don't short-circuit on "id format invalid" with a faster path — an attacker will measure latency and notice.

`adcp fuzz` runs a paired-probe invariant that enforces this automatically. Pass two test tenants via `--auth-token` + `--auth-token-cross-tenant` for full coverage (see [VALIDATE-YOUR-AGENT.md § Uniform-error-response invariant](../../docs/guides/VALIDATE-YOUR-AGENT.md#uniform-error-response-invariant-paired-probe)). The invariant fails loudly with a byte-level diff pointing at the offending channel.

<a name="composing-oauth-signing-and-idempotency"></a>

### Composing OAuth, signing, and idempotency

Each concern above is straightforward in isolation. The pitfalls are at their boundaries. A production seller that claims both `sales-guaranteed` and `signed-requests` and sits behind OAuth wires them through `serve()`'s composition hooks — not external Express middleware.

**The pipeline.** `serve({ authenticate, preTransport })` runs steps in this order and buffers the request body into `req.rawBody` so the signature verifier can hash it without racing the MCP transport:

```typescript
import { serve } from '@adcp/sdk';
// verifyBearer / verifyApiKey / anyOf live on the server subpath, not the root barrel:
import { verifyBearer } from '@adcp/sdk/server';
// Low-level verifier is preTransport-shaped: use it instead of createExpressVerifier
// (which is Express (req, res, next) middleware and won't type-check against preTransport):
import {
  verifyRequestSignature,
  RequestSignatureError,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  type VerifierCapability,
} from '@adcp/sdk/signing/server';

const capability: VerifierCapability = {
  supported: true,
  required_for: ['create_media_buy', 'update_media_buy', 'acquire_rights'],
  supported_for: ['sync_creatives', 'sync_audiences', 'sync_accounts'],
  covers_content_digest: 'required',
};
const jwks = new StaticJwksResolver([
  // JWKs array — each must carry its own `kid`.
]);
const replayStore = new InMemoryReplayStore();
const revocationStore = new InMemoryRevocationStore({
  issuer: 'https://seller.example.com/mcp',
  updated: new Date().toISOString(),
  next_update: new Date(Date.now() + 24 * 3600_000).toISOString(),
  revoked_kids: [],
  revoked_jtis: [],
});

serve(createAgent, {
  publicUrl: 'https://seller.example.com/mcp',

  // 1. authenticate runs first. Bad/missing bearer → 401 Bearer challenge.
  //    serve() populates extra.authInfo, which the framework surfaces as ctx.authInfo.
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: 'https://seller.example.com/mcp',
    requiredScopes: ['adcp:seller'],
  }),
  protectedResource: { authorization_servers: ['https://auth.example.com'] },

  // 2. preTransport: raw http (req, res) => Promise<boolean>. Verify the
  //    RFC 9421 signature here, using req.rawBody pre-buffered by serve().
  //    Return true only if you wrote the response yourself; return false to
  //    continue into MCP dispatch. Throwing produces a generic 500.
  preTransport: async (req, res) => {
    try {
      await verifyRequestSignature(
        { method: req.method!, url: req.url!, headers: req.headers, body: req.rawBody ?? '' },
        {
          capability,
          jwks,
          replayStore,
          revocationStore,
          operation: resolveOperation(req), // your function: extract the AdCP operation name from the request
        }
      );
    } catch (err) {
      if (err instanceof RequestSignatureError) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', `Signature error="${err.code}"`);
        res.end();
        return true; // handled
      }
      throw err;
    }
    return false; // continue to MCP dispatch
  },

  // 3. MCP transport parses JSON and dispatches to the framework server.
  // 4. Framework applies the idempotency store per handler — you don't mount it.
});
```

**Principal threading.** `resolveSessionKey(ctx)` receives only `{toolName, params, account}` — no auth info. To compose the OAuth subject into the idempotency key you need `resolveIdempotencyPrincipal`, which receives the full `HandlerContext` including `ctx.authInfo` (populated by `verifyBearer` through MCP's `extra.authInfo`):

```typescript
createAdcpServerFromPlatform(myPlatform, {
  // ...
  // SessionKeyContext has no authInfo — use this for coarse per-account scoping:
  resolveSessionKey: ctx => ctx.account?.id,

  // HandlerContext has authInfo — use this when the idempotency namespace must
  // be scoped to the authenticated principal:
  resolveIdempotencyPrincipal: ctx => {
    const clientId = ctx.authInfo?.clientId;
    if (!clientId)
      throw new Error('unauthenticated request reached idempotency scope — check authenticate is configured');
    // Multi-tenant AS: if the JWT carries a tenant claim, verifyBearer surfaces
    // it in ctx.authInfo.extra. Compose so sub collisions across tenants don't
    // share a replay namespace:
    const tenant = ctx.authInfo?.extra?.tenant_id as string | undefined;
    return tenant ? `${tenant}:${clientId}` : clientId;
  },
});
```

Composing the verified signing `keyid` in is possible but lives outside the handler context: the signing middleware stashes it on `req.verifiedSigner.keyid` (raw HTTP request), which doesn't flow into `HandlerContext` by default. Either accept that the idempotency namespace is OAuth-principal-only (most setups), or write a custom `authenticate` that promotes the verified keyid into `authInfo.extra` so your `resolveIdempotencyPrincipal` can read it uniformly.

**401 disambiguation.** A request can fail both OAuth and signature verification. Per RFC 7235 you can emit multiple `WWW-Authenticate` challenges — order them so the client's most promising next step is first. OAuth's Bearer challenge always fires first (the client can't sign correctly until it has a valid identity); Signature challenge only fires when the request is authenticated but signed wrong.

```typescript
// Inside preTransport, after a RequestSignatureError is raised on an authenticated request:
res.statusCode = 401;
res.setHeader(
  'WWW-Authenticate',
  [
    // If the bearer also failed, the Bearer challenge would have been emitted by `authenticate`
    // before preTransport ran — you only reach this branch on authenticated-but-bad-signature.
    `Signature error="${err.code}"`,
    // If you want to emit both (e.g., you implement your own authenticator that doesn't
    // short-circuit on missing bearer), the Bearer challenge goes first:
    // 'Bearer error="invalid_token", resource_metadata="https://seller.example.com/.well-known/oauth-protected-resource"',
  ].join(', ')
);
res.end();
```

Matrix:

- No/expired bearer → framework emits `Bearer error="invalid_token", resource_metadata=...`. Request never reaches `preTransport`.
- Valid bearer, signature invalid → your `preTransport` emits `Signature error="<code>"` byte-matching the test vector's `expected_outcome.error_code`.
- Valid bearer, signature absent on a `supported_for`-only operation → accept; signature is advisory on `supported_for`. Only `required_for` rejects unsigned.

**Idempotency semantics for `submitted` responses.** The framework caches **every successful mutation** including async `submitted` envelopes — not only terminal ones. A replay of the same key within the TTL returns the cached `submitted` response with `replayed: true` injected. A second IO is **not** created. Parallel calls with the same key within the 120-second in-flight window get `adcpError('SERVICE_UNAVAILABLE', { retry_after: 1 })` and should retry — buyer SDKs auto-retry on the `transient` class. The framework emits this for you; you don't handle it in handler code.

This means: the `task_id` you return on a `sales-guaranteed` `create_media_buy` is stable under replay. The buyer polls (or gets webhooks on) the same task handle on any retry within the replay window — you don't create a second IO.

**The three idempotency error codes the framework emits:**

| Code                                     | When                                                                    | Buyer's next step                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `SERVICE_UNAVAILABLE` (`retry_after: 1`) | Parallel call with the same key, still within the 120s in-flight window | Wait the `retry_after` seconds and retry — eventually replays the cached response or hits CONFLICT |
| `IDEMPOTENCY_CONFLICT`                   | Same key, different payload hash                                        | Don't retry — buyer has a client bug generating the same key for different requests                |
| `IDEMPOTENCY_EXPIRED`                    | Key replayed after the TTL (default 24h, configurable 1h–7d)            | Mint a new key and retry                                                                           |

<a name="webhooks-async-completion-signed-outbound"></a>

## Webhooks (async completion, signed outbound)

Most seller flows need outbound webhooks — `sales-guaranteed` fires on IO completion, `sales-broadcast-tv` fires `window_update` deliveries as C3/C7 data matures, `update_media_buy` fires on bid/budget application. **Don't hand-roll `fetch` with HMAC**. Pass `webhooks: { signerKey }` to `createAdcpServerFromPlatform` and call `ctx.emitWebhook(...)` from any handler — the framework handles RFC 9421 signing, nonce minting, stable `idempotency_key` across retries, 5xx/429 backoff, byte-identical JSON serialization, and the "don't retry on signature failures" terminal behavior.

```typescript
import {
  createAdcpServerFromPlatform,
  serve,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
} from '@adcp/sdk/server';

// Dev: generate a signer JWK once at boot. Production: load from KMS/env with a stable `kid`,
// and publish the public half at your `jwks_uri` so buyers can verify without OOB exchange.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
const { privateKey } = generateKeyPairSync('ed25519');
const signerJwk = {
  ...privateKey.export({ format: 'jwk' }),
  kid: 'seller-webhook-kid-2026',
  alg: 'EdDSA',
  adcp_use: 'webhook-signing',
  key_ops: ['sign'],
};

class WebhookSeller implements DecisioningPlatform {
  capabilities = {
    specialisms: ['sales-guaranteed'] as const,
    pricingModels: ['cpm'] as const,
    channels: ['display'] as const,
    config: {},
  };

  accounts: AccountStore = {
    resolve: async ref => ({
      id: 'account_id' in ref ? ref.account_id : 'default',
      operator: 'me',
      ctx_metadata: {},
    }),
    upsert: async () => ({ ok: true, items: [] }),
    list: async () => ({ items: [], nextCursor: null }),
  };

  sales: SalesPlatform = {
    getProducts: async () => ({ products: [] }),
    createMediaBuy: async (req, ctx) => {
      // sales-guaranteed: IO signing completes async. Emit the final result on completion.
      const taskId = `task_${randomUUID()}`;

      // Capture ctx.emitWebhook into a local BEFORE scheduling — the handler returns
      // immediately, but the closure outlives the request; ctx may be recycled.
      const emit = ctx.emitWebhook!; // non-null: guaranteed populated when webhooks config is set

      queueIoReview(req, async outcome => {
        await emit({
          url: (req as { push_notification_config?: { url: string } }).push_notification_config!.url,
          payload: {
            task: {
              task_id: taskId,
              status: outcome.approved ? 'completed' : 'rejected',
              result: outcome.approved
                ? { media_buy_id: outcome.media_buy_id, packages: outcome.packages }
                : undefined,
            },
          },
          operation_id: `create_media_buy.${taskId}`, // stable across retries — framework reuses same idempotency_key
        });
      });
      return { status: 'submitted', task_id: taskId }; // synchronous response is the task envelope
    },
    updateMediaBuy: async (id, patch) => ({ media_buy_id: id, status: 'active' }),
    getMediaBuys: async () => ({ media_buys: [] }),
    getMediaBuyDelivery: async () => ({ deliveries: [] }),
    syncCreatives: async () => [],
    listCreativeFormats: async () => ({ formats: [] }),
  };
}

serve(() =>
  createAdcpServerFromPlatform(new WebhookSeller(), {
    name: 'My Seller',
    version: '1.0.0',
    webhooks: {
      signerKey: { keyid: signerJwk.kid, alg: 'ed25519', privateKey: signerJwk },
      // Optional: retries, idempotencyKeyStore (swap memory → pg for multi-replica)
    },
  })
);
```

**`ctx.emitWebhook` is typed optional** (`emitWebhook?:`) even when you configure `webhooks` on the server. The framework populates it on every handler once `webhooks.signerKey` is set; use `ctx.emitWebhook!` or a local guard. Strict-mode assert-once-at-boot works too.

**Return envelope — use `taskToolResponse`, not the default `mediaBuyResponse` wrap.** The framework auto-wraps `createMediaBuy` returns with `mediaBuyResponse`, which stamps `revision`/`confirmed_at`/`valid_actions` onto the response — semantically wrong on a `submitted` envelope. For submitted returns, import `taskToolResponse` from `@adcp/sdk/server` and wrap explicitly (see [§ sales-guaranteed](#specialism-sales-guaranteed) for the full pattern).

**`operation_id` must be stable across retries.** The emitter hashes `operation_id` into the outbound `idempotency_key` so receivers can dedupe retried deliveries. Regenerating `operation_id` on retry is the top at-least-once-delivery bug the webhook conformance runner catches — use an ID derived from the logical event (the task_id, media_buy_id, or report batch), not a timestamp or fresh UUID.

**Terminal errors.** The emitter stops retrying on 4xx and on 401 responses carrying `WWW-Authenticate: Signature error="webhook_signature_*"` — signature failures are deterministic and retrying produces identical rejection. 5xx and 429 retry with exponential backoff.

**Legacy buyers.** If a buyer registered `push_notification_config.authentication` with HMAC-SHA256 or Bearer credentials, the emitter honors that mode automatically (deprecated in 4.0 but supported for backward compatibility). Omit `authentication` to opt into the RFC 9421 webhook profile by default.

**Revocation webhooks (brand-rights).** When your agent revokes a rights grant, `ctx.emitWebhook` against the buyer's `revocation_webhook` URL — see `skills/build-brand-rights-agent/SKILL.md` for the payload shape.

## Before Writing Code

Determine these five things. Ask the user — don't guess.

### 1. What Kind of Seller?

- **Premium publisher** — guaranteed inventory, fixed pricing, IO approval (ESPN, NYT)
- **SSP / Exchange** — non-guaranteed, auction-based, instant activation
- **Retail media network** — both guaranteed and non-guaranteed, proposals, catalog-driven creative, conversion tracking

### 2. Guaranteed or Non-Guaranteed?

- **Guaranteed** — `delivery_type: "guaranteed"`, may require async approval (`submitted` → `pending_approval` → `confirmed`)
- **Non-guaranteed** — `delivery_type: "non_guaranteed"`, buyer sets `bid_price`, instant activation

Many sellers support both — different products can have different delivery types.

### 3. Products and Pricing

Get specific inventory. Each product needs:

- `product_id`, `name`, `description`
- `publisher_properties` — at least one `{ publisher_domain: 'example.com', selection_type: 'all' }` (discriminated union: `'all'` | `'by_id'` with `property_ids` | `'by_tag'` with `tags`)
- `format_ids` — array of `{ agent_url: string, id: string }` referencing creative formats
- `delivery_type` — `'guaranteed'` or `'non_guaranteed'`
- `pricing_options` — at least one (see below)
- `reporting_capabilities` — `{ available_reporting_frequencies: ['daily'], expected_delay_minutes: 240, timezone: 'UTC', supports_webhooks: false, available_metrics: ['impressions', 'spend', 'clicks'], date_range_support: 'date_range' }`
- Optional: `channels` — use `as const` to avoid `string[]` inference: `channels: ['display', 'olv'] as const`

Pricing models (all require `pricing_option_id` and `currency`):

- `cpm` — `{ pricing_option_id: 'cpm-1', pricing_model: "cpm", fixed_price: 12.00, currency: "USD" }`
- `cpc` — `{ pricing_option_id: 'cpc-1', pricing_model: "cpc", fixed_price: 1.50, currency: "USD" }`
- Auction — `{ pricing_option_id: 'auction-1', pricing_model: "cpm", floor_price: 5.00, currency: "USD" }` (buyer bids above floor)

Each pricing option can set `min_spend_per_package` to enforce minimum budgets.

For all `PricingOption` variants and `Product` required fields, see [`docs/TYPE-SUMMARY.md`](../../docs/TYPE-SUMMARY.md).

### 4. Approval Workflow

For guaranteed buys, choose one:

- **Instant confirmation** — `create_media_buy` returns completed with confirmed status. Simplest.
- **Async approval** — returns `submitted`, buyer polls `get_media_buys`. Use `registerAdcpTaskTool`.
- **Human-in-the-loop** — returns `input-required` with a setup URL for IO signing.

Non-guaranteed buys are always instant confirmation.

### 5. Creative Management

- **Standard** — `list_creative_formats` + `sync_creatives`. Buyer uploads assets, seller validates.
- **Catalog-driven** — buyer syncs product catalog via `sync_catalogs`. Common for retail media.
- **None** — creative handled out-of-band. Omit creative tools.

## <a name="tools-and-required-response-shapes"></a>Tools and Required Response Shapes

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``(e.g.`#### \`create_media_buy\``) to read the exact required + optional field list.** The schema-derived contract lives there; this skill covers patterns, gotchas, and domain-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift, so write the obvious thing and trust the contract.
>
> **Cross-cutting pitfalls matrix runs keep catching:**
>
> - **Declare `capabilities.specialisms: ['sales-guaranteed']` (or your actual specialism) on the platform you pass to `createAdcpServerFromPlatform`.** Value is `string[]` of enum ids (not `[{id, version}]`). Agents that don't declare their specialism fail the grader with "No applicable tracks found" even if every tool works — tracks are gated on the specialism claim.
> - `get_media_buy_delivery` response requires **top-level `currency: string`** (ISO 4217) — per-row `spend.currency` is NOT enough.
> - `get_media_buy_delivery /media_buy_deliveries[i]/by_package[j]` rows are strict: each requires `package_id`, `spend` (number), `pricing_model`, `rate` (number), and `currency`. A mock that returns `{package_id, impressions, clicks}` fails validation — include the billing quintet on every package row.
> - `get_media_buy_delivery /reporting_period/start` and `/end` are ISO 8601 **date-time** strings (`YYYY-MM-DDTHH:MM:SS.sssZ` via `new Date().toISOString()`), not date-only. A mock that returns `'2026-04-21'` fails the format check in GA.
> - `get_media_buys /media_buys[i]` rows require **`media_buy_id`, `status`, `currency`, `total_budget`, `packages`**. When you persist a buy in `create_media_buy`, save `currency` and `total_budget` so the `get_media_buys` response can echo them verbatim — reconstructing later drops one of the required fields in ~every Claude build we've tested.
> - `sync_accounts` response: each row in `accounts[]` requires **`action: 'created' | 'updated' | 'unchanged' | 'failed'`** (not just `account_id`, `status`). Compare to sync_creatives — same pattern. Omitting `action` fails schema validation at `/accounts/0/action` and blocks every downstream stateful step in the storyboard. Type your row array as `SyncAccountsResponseRow[]` (exported from `@adcp/sdk`) to catch the missing-`action` drift at compile time instead of runtime.

**`get_adcp_capabilities`** — register first, empty `{}` schema

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['media_buy'],
})
```

**`sync_accounts`** — `SyncAccountsRequestSchema.shape`

```
taskToolResponse({
  accounts: [{
    account_id: string,       // required - your platform's ID
    brand: { domain: string },// required - echo back from request
    operator: string,         // required - echo back from request
    action: 'created' | 'updated',  // required
    status: 'active' | 'pending_approval',  // required
  }]
})
```

**`sync_governance`** — `SyncGovernanceRequestSchema.shape`

```
taskToolResponse({
  accounts: [{
    account: { brand: {...}, operator: string },  // required - echo back
    status: 'synced',         // required
    governance_agents: [{ url: string, categories?: string[] }],  // required
  }]
})
```

**`get_products`** — `GetProductsRequestSchema.shape`

```
productsResponse({
  products: [{
    product_id: 'prod-1',
    name: 'Homepage Display',
    description: 'Premium display ads on homepage',
    publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
    format_ids: [{ agent_url: 'https://creative.example.com/mcp', id: 'display-300x250' }],
    delivery_type: 'guaranteed',
    pricing_options: [{
      pricing_option_id: 'cpm-standard',
      pricing_model: 'cpm',
      fixed_price: 12.00,
      currency: 'USD',
    }],
    reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES,  // from @adcp/sdk/server — stays in sync with schema
  }],
  sandbox: true,        // for mock data
})
```

`DEFAULT_REPORTING_CAPABILITIES` is the SDK-provided default. Hand-rolling this object is an ongoing drift tax — the spec adds required fields (most recently `date_range_support`) and every copy of the literal gets stale. Reach for the constant unless you have a concrete reason to override a field.

**`create_media_buy`** — `CreateMediaBuyRequestSchema.shape`

Return `adcpError(...)` for all business validation failures. Error-code matrix — all spec-defined rejections on `create_media_buy` / `update_media_buy`:

| Tool | Condition | Code |
| --- | --- | --- |
| `create_media_buy` | `performance_standards` or `measurement_terms` on a package are unacceptable | `adcpError('TERMS_REJECTED', { message: '...' })` |
| `create_media_buy` | `product_id` on a package not in catalog | `adcpError('PRODUCT_NOT_FOUND', { field: 'packages[N].product_id' })` |
| `create_media_buy` | reversed dates, budget below floor, schema violation | `adcpError('INVALID_REQUEST', { message: '...' })` |
| `update_media_buy` | `media_buy_id` not found | `adcpError('MEDIA_BUY_NOT_FOUND', { field: 'media_buy_id' })` |
| `update_media_buy` | `package_id` within a valid buy not found | `adcpError('PACKAGE_NOT_FOUND', { field: 'package_id' })` |

```
// Success — revision, confirmed_at, and valid_actions are auto-set:
mediaBuyResponse({
  media_buy_id: string,       // required
  status: 'pending_creatives',// triggers valid_actions auto-population
  packages: [{                // required
    package_id: string,
    product_id: string,
    pricing_option_id: string,
    budget: number,
  }],
})

// Validation failure (reversed dates, budget too low, unknown product):
adcpError('INVALID_REQUEST', { message: 'start_time must be before end_time' })
```

**`get_media_buys`** — `GetMediaBuysRequestSchema.shape`

```
getMediaBuysResponse({
  media_buys: [{
    media_buy_id: string,   // required
    status: 'active' | 'pending_start' | 'pending_creatives' | ...,  // required
    currency: 'USD',        // required
    total_budget: 5000,     // required — numeric, same currency as `currency`
    confirmed_at: string,   // required for guaranteed approval — ISO timestamp
    packages: [{
      package_id: string,   // required
    }],
  }]
})
```

When you persist a media buy, save `currency` + `total_budget` from the `create_media_buy` request (budgets sum across packages) so subsequent `get_media_buys` calls can return them verbatim. Missing either field on any row fails schema validation and every subsequent step depending on that media_buy's history.

**`list_creative_formats`** — `ListCreativeFormatsRequestSchema.shape`

```
listCreativeFormatsResponse({
  formats: [{
    format_id: { agent_url: string, id: string },  // required
    name: string,                                  // required
    renders: [{                                    // required — at least one render
      role: 'primary',                             // required
      // oneOf: specify dimensions OR parameters_from_format_id, not both
      dimensions: { width: 300, height: 250 },     // object — defaults to px
      // parameters_from_format_id: true,          // alternative: parameters come from format_id
    }],
  }]
})
```

#### Format asset slots — translating platform-native constraints to AdCP

Social and retail-media sellers translate platform-native format catalogs (Meta, Pinterest, TikTok, Criteo, CitrusAd, UniversalAds) into AdCP's `Format.assets[]`. Four recurring footguns fail strict response validation even when the data is "there":

1. **Wrong field name for file types.** The spec uses `formats` on image requirements and `containers` on video requirements — NOT `file_types`. Platforms commonly carry `file_types: ['mp4']`; remap to `containers: ['mp4']` for video, `formats: ['jpg', 'png']` for image.
2. **Wrong unit on duration.** AdCP uses `min_duration_ms` / `max_duration_ms` (milliseconds). Platforms often carry `min_duration_seconds`. Multiply by 1000 on translation.
3. **Aspect ratios are single-valued per format.** Image pattern `^\d+(\.\d+)?:\d+(\.\d+)?$` allows decimals (`1.91:1`); video is integer-only `^\d+:\d+$`. Comma-joined values (`"1:1,16:9"`) fail — emit separate format variants per ratio.
4. **`min_count` / `max_count` live on the repeatable_group wrapper.** Carousels, collections, story-pin frames, product showcases are `repeatable_group` assets with `assets[]` inside. Putting counts on an individual asset slot is a spec violation that strict validation rejects.

Retail-media sponsored-products formats often reach for `asset_type: 'promoted_offerings'`. That value isn't in the AdCP enum — the correct choice is `asset_type: 'catalog'` with a `CatalogRequirements` object declaring `catalog_type: 'product'` (or `offering`, etc.), `min_items`, `max_items`, and the expected `feed_formats`.

Use the typed slot builders — they inject `item_type` and `asset_type`, and the `requirements` object is strictly typed per asset_type, so `file_types`, `min_duration_seconds`, and `min_count` on an individual asset all fail at compile time:

```typescript
import {
  imageAssetSlot,
  videoAssetSlot,
  catalogAssetSlot,
  repeatableGroup,
  imageGroupAsset,
  textGroupAsset,
} from '@adcp/sdk';

// Single image asset slot
imageAssetSlot({
  asset_id: 'hero_image',
  required: true,
  requirements: { aspect_ratio: '1:1', formats: ['jpg', 'png', 'webp'], max_file_size_kb: 5120 },
});

// Carousel: 2–5 images. Counts on the GROUP, not the individual image.
repeatableGroup({
  asset_group_id: 'carousel_items',
  required: true,
  min_count: 2,
  max_count: 5,
  selection_mode: 'sequential',
  assets: [
    imageGroupAsset({
      asset_id: 'card_image',
      required: true,
      requirements: { aspect_ratio: '1:1', formats: ['jpg', 'png'] },
    }),
    textGroupAsset({ asset_id: 'card_headline', required: true, requirements: { max_length: 40 } }),
  ],
});

// Sponsored-products: catalog slot, not 'promoted_offerings'
catalogAssetSlot({
  asset_id: 'products',
  required: true,
  requirements: {
    catalog_type: 'product',
    min_items: 3,
    max_items: 10,
    feed_formats: ['google_merchant_center'],
  },
});
```

Grouped namespace `FormatAsset.image(...)`, `FormatAsset.group(...)`, etc. is available when constructing several slot types together.

**`sync_creatives`** — `SyncCreativesRequestSchema.shape`

```
syncCreativesResponse({
  creatives: [{
    creative_id: string,          // required - echo from request
    action: 'created' | 'updated',  // required
  }]
})
```

**`get_media_buy_delivery`** — `GetMediaBuyDeliveryRequestSchema.shape`

```
deliveryResponse({
  reporting_period: { start: string, end: string },  // required - ISO timestamps
  currency: 'USD',                                    // required — top-level currency for all totals
  media_buy_deliveries: [{
    media_buy_id: string,     // required
    status: 'active',         // required
    totals: { impressions: number, spend: number },  // required
    by_package: [],           // required (can be empty)
  }]
})
```

Top-level `currency` is **required** per `get-media-buy-delivery-response.json`. Pull it from the persisted media buy (see `createMediaBuy` above — we flatten request `total_budget.currency` into the buy's top-level `currency` field for this reason). `get_creative_delivery` has the same top-level `currency` requirement.

### Context and Ext Passthrough

The framework auto-echoes the request's `context` into every response — **do not set `context` yourself in your handler return values.** The framework injects it post-handler only when the field isn't already present.

**Crucial:** `context` is schema-typed as an object. If your handler hand-sets a string or narrative description (e.g., "E2E test run", a scenario label, `campaign_context` from the request body), validation fails with `/context: must be object` and the framework does not overwrite. Leave the field out entirely; the framework handles it.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `sync_governance`, `provide_performance_feedback`, `sync_event_sources`.

## Compliance Testing (Required for deterministic_testing storyboard)

To pass the `deterministic_testing` storyboard — and the rejection-branch steps in most other storyboards (`governance_denied`, `invalid_transitions`, `measurement_terms_rejected`, etc.) — your agent must expose the `comply_test_controller` tool. Without it, the grader can only observe the happy path; forced state transitions, error-condition seeding, and simulation all silently degrade to skips or fail with `controller_detected: false`.

**Pick by state shape — not by helper quality.** Both helpers below call the same underlying primitives; the split is about the shape of the state you're mutating, not a gradient of abstraction.

| Your domain state is…                                                                                                                          | Use                                                          | Worked example                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Simple — each scenario maps cleanly to one repository method (`seed_creative` → `creativeRepo.upsert`)                                         | `createComplyController`                                     | [`examples/comply-controller-seller.ts`](../../examples/comply-controller-seller.ts) |
| Typed — media buys with packages / revision / history, creatives with format*id / manifest, seed must populate the same records `get*\*` reads | `registerTestController` + hand-rolled `TestControllerStore` | [`examples/seller-test-controller.ts`](../../examples/seller-test-controller.ts)     |

### Option A: `createComplyController` (adapter surface)

Handles dispatch + validation + re-seed idempotency + sandbox gating for you. Your adapter bodies run; the helper routes:

```ts
import { createComplyController } from '@adcp/sdk/testing';

const controller = createComplyController({
  sandboxGate: input => input.auth?.sandbox === true,
  seed: {
    product: params => productRepo.upsert(params.product_id, params.fixture),
    creative: params => creativeRepo.upsert(params.creative_id, params.fixture),
    plan: params => planRepo.upsert(params.plan_id, params.fixture),
    media_buy: params => mediaBuyRepo.upsert(params.media_buy_id, params.fixture),
  },
  force: {
    creative_status: params => creativeRepo.transition(params.creative_id, params.status),
    media_buy_status: params => mediaBuyRepo.transition(params.media_buy_id, params.status),
    account_status: params => accountRepo.setStatus(params.account_id, params.status),
  },
  simulate: {
    delivery: params => deliveryRepo.simulate(params),
    budget_spend: params => budgetRepo.spendPercentage(params),
  },
});

controller.register(server);
```

Omit adapters you don't support — they auto-return `UNKNOWN_SCENARIO` (not schema errors). Throw `TestControllerError('INVALID_TRANSITION', msg, currentState)` from an adapter when the state machine disallows the transition; the helper emits the typed error envelope.

Registration auto-emits the `capabilities.compliance_testing.scenarios` block per AdCP 3.0 — `controller.register(server)` wires the tool AND declares capability. Don't add `compliance_testing` to `supported_protocols`; per spec it's a capability block, not a protocol.

Validate with: `adcp storyboard run <agent> deterministic_testing --auth $TOKEN`.

### Seeding fixtures for compliance

Group A storyboards call `comply_test_controller.seed_product` (and `seed_pricing_option`, `seed_creative`, `seed_plan`, `seed_media_buy`) to install a storyboard-specific fixture before hitting the spec tools. Two SDK pieces make this round-trip work without hand-rolling the merge + lookup plumbing.

**1. `mergeSeed*` helpers** — permissive merge over your seller defaults. Storyboard fixtures declare only the fields they want to override; everything else (delivery type, channels, reporting capabilities, ...) comes from your baseline. Arrays replace by default; id-keyed lists (`pricing_options`, `publisher_properties`, `packages`, `assets`, plan `findings`) overlay by their id so seeding one entry doesn't wipe the rest.

```ts
import { mergeSeedProduct } from '@adcp/sdk/testing';

const baseline: Partial<Product> = {
  delivery_type: 'guaranteed',
  channels: ['display'],
  reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES,
};

// Storyboard seeds sparse fixture: { product_id: 'prd-1', name: 'Homepage' }
const merged = mergeSeedProduct(baseline, fixture);
productRepo.upsert(merged.product_id, merged);
```

**2. `bridgeFromTestControllerStore`** — wires your seeded `Map` into `get_products` responses automatically. Sandbox requests see seeded + handler products merged (with seeded winning collisions); production traffic (no sandbox marker, or resolved non-sandbox account) skips the bridge entirely.

```ts
import { createAdcpServerFromPlatform, bridgeFromTestControllerStore, DEFAULT_REPORTING_CAPABILITIES } from '@adcp/sdk/server';

const seedStore = new Map<string, unknown>();

const server = createAdcpServerFromPlatform(myPlatform, {
  name: 'My Seller',
  version: '1.0.0',
  testController: bridgeFromTestControllerStore(seedStore, {
    delivery_type: 'guaranteed',
    channels: ['display'],
    reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES,
  }),
});

// Wire your createComplyController seed.product adapter to populate seedStore.
```

Your `getSeededProducts` callback — whether you write it by hand or get it via `bridgeFromTestControllerStore` — MUST re-verify that `ctx.account` (or an equivalent scope) is a sandbox account. The framework's sandbox check is a namespace selector, not an authority boundary.

### Option B: `registerTestController` (flat store surface)

Pick this when your seed and force handlers must mutate typed domain records (`MediaBuyState` with packages / revision / history) that your production tools already read. Session-scoped store factories close over a loaded session so every mutation lands in the same records `get_media_buy` / `sync_creatives` return — the drift class the flat store prevents.

See [`examples/seller-test-controller.ts`](../../examples/seller-test-controller.ts) for the end-to-end pattern (typed `MediaBuyState` + `CreativeState`, per-request factory, `enforceMapCap` + `createSeedFixtureCache`, transition guards shared with production code). Sketch:

```
import { registerTestController, type TestControllerStore } from '@adcp/sdk/testing';

const store: TestControllerStore = {
  async forceAccountStatus(accountId, status) {
    const prev = accounts.get(accountId);
    if (!prev) throw new TestControllerError('NOT_FOUND', `Account ${accountId} not found`);
    accounts.set(accountId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async forceMediaBuyStatus(mediaBuyId, status) {
    const prev = mediaBuys.get(mediaBuyId);
    if (!prev) throw new TestControllerError('NOT_FOUND', `Media buy ${mediaBuyId} not found`);
    const terminal = ['completed', 'rejected', 'canceled'];
    if (terminal.includes(prev))
      throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from ${prev}`, prev);
    mediaBuys.set(mediaBuyId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async forceCreativeStatus(creativeId, status, rejectionReason) {
    const prev = creatives.get(creativeId);
    if (!prev) throw new TestControllerError('NOT_FOUND', `Creative ${creativeId} not found`);
    // archived blocks transitions to active states, but archived → rejected is valid (compliance override)
    const activeStatuses = ['processing', 'pending_review', 'approved'];
    if (prev === 'archived' && activeStatuses.includes(status))
      throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from archived to ${status}`, prev);
    creatives.set(creativeId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async simulateDelivery(mediaBuyId, params) {
    // params: { impressions?: number, clicks?: number, reported_spend?: { amount, currency }, conversions?: number }
    return { success: true, simulated: { ...params }, cumulative: { ...params } };
  },
  async simulateBudgetSpend(params) {
    return { success: true, simulated: { spend_percentage: params.spend_percentage } };
  },
};

registerTestController(server, store);
```

`registerTestController` auto-emits the `capabilities.compliance_testing.scenarios` block per AdCP 3.0 — scenarios come from the factory's static list or are inferred from the plain store's method presence. Don't add `compliance_testing` to `supported_protocols`; per spec it's a capability block, not a protocol. Unimplemented methods are excluded from `list_scenarios` automatically.

The storyboard tests state machine correctness:

- `NOT_FOUND` when forcing transitions on unknown entities
- `INVALID_TRANSITION` when transitioning from terminal states (completed, rejected, canceled for media buys; archived blocks active states like processing/pending_review/approved, but archived → rejected is valid)
- Successful transitions between valid states

Throw `TestControllerError` from store methods for typed errors. The SDK validates status enum values before calling your store.

Validate with: `adcp storyboard run <agent> deterministic_testing --json`

### Advanced patterns (session-backed stores, map caps, custom wrappers)

For production test controllers with persisted-session state (Postgres/Redis/JSONB), the per-session factory shape, `enforceMapCap` for bounded session maps, and custom MCP wrappers with `AsyncLocalStorage` or sandbox gating — see [`docs/guides/BUILD-AN-AGENT.md`](../../docs/guides/BUILD-AN-AGENT.md) § createTaskCapableServer.

Key SDK pieces you'll import from `@adcp/sdk`: `CONTROLLER_SCENARIOS`, `enforceMapCap`, `SESSION_ENTRY_CAP`, `handleTestControllerRequest`, `toMcpResponse`, `TOOL_INPUT_SHAPE`.

## SDK Quick Reference

| SDK piece                                                                 | Usage                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `createAdcpServerFromPlatform(platform, opts)`                            | Build a server from a typed `DecisioningPlatform` — compile-time specialism enforcement, ctx_metadata round-trip, idempotency-principal synthesis, status mappers, webhook auto-emit |
| `createAdcpServer(config)` *(legacy)*                                     | v5 handler-bag entry. Mid-migration / escape-hatch only; reach via `@adcp/sdk/server/legacy/v5`                                                                                       |
| `serve(() => createAdcpServerFromPlatform(platform, opts))`               | Start HTTP server on `:3001/mcp`                                               |
| `ctx.store`                                                               | State store in every handler — `get`, `put`, `patch`, `delete`, `list`         |
| `InMemoryStateStore`                                                      | Default state store (dev/testing)                                              |
| `PostgresStateStore`                                                      | Production state store (shared across instances)                               |
| `DEFAULT_REPORTING_CAPABILITIES`                                          | Use as `reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES` on products    |
| `checkGovernance(options)`                                                | Call governance agent before financial commits                                 |
| `governanceDeniedError(result)`                                           | Convert governance denial to GOVERNANCE_DENIED error                           |
| `mediaBuyResponse(data)`                                                  | Auto-applied for `createMediaBuy` (sets revision, confirmed_at, valid_actions) |
| `adcpError(code, { message })`                                            | Structured error (e.g., `BUDGET_TOO_LOW`, `PRODUCT_NOT_FOUND`)                 |
| `registerTestController(server, store \| { scenarios, createStore })`     | Add `comply_test_controller`. Plain store or per-request factory.              |
| `TestControllerError(code, message)`                                      | Typed error from store methods                                                 |
| `handleTestControllerRequest(store, input)`                               | Low-level dispatch for custom MCP wrappers                                     |
| `toMcpResponse(response)` / `TOOL_INPUT_SHAPE`                            | MCP envelope + Zod input schema for custom wrappers                            |
| `enforceMapCap(map, key, label, cap?)`                                    | Reject net-new keys once a session Map hits `SESSION_ENTRY_CAP` (1000)         |
| `expectControllerError(result, code)` / `expectControllerSuccess(result)` | Unit-test assertions — narrow responses to error or success arms               |

Response builders (`productsResponse`, `mediaBuyResponse`, `deliveryResponse`, etc.) are auto-applied by the framework — you return the data, the framework wraps it. You only need to call them directly for tools without a dedicated builder.

Import everything from `@adcp/sdk`. Types from `@adcp/sdk` with `import type`.

## Setup

```bash
npm init -y
npm install @adcp/sdk
npm install -D typescript @types/node
```

Minimal `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  }
}
```

`skipLibCheck: true` avoids false-positive errors from transitive `.d.ts` files (e.g., `@opentelemetry/api`).

## Implementation

Use `createAdcpServerFromPlatform` — it auto-wires schemas, response builders, and `get_adcp_capabilities` from the typed `DecisioningPlatform` you provide. Handlers receive `(params, ctx)` where `ctx.store` persists state, `ctx.account` is the resolved account, and `ctx.ctxMetadata` is the resource-keyed cache (when wired).

**Imports**: most things live at `@adcp/sdk`. The idempotency store helpers (`createIdempotencyStore`, `memoryBackend`, `pgBackend`) live at the narrower `@adcp/sdk/server` subpath. Both are re-exported from the root — either works — but splitting them makes intent obvious.

```typescript
import { randomUUID } from 'node:crypto';
import {
  createAdcpServerFromPlatform,
  serve,
  adcpError,
  InMemoryStateStore,
  checkGovernance,
  governanceDeniedError,
  createIdempotencyStore,
  memoryBackend,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
} from '@adcp/sdk/server';
import type { ServeContext } from '@adcp/sdk';

// Publisher-typed metadata blob round-tripped via Account.ctx_metadata.
// Whatever shape your adapter wants — the SDK doesn't inspect it.
interface MySellerMeta {
  governanceUrl?: string;
  brand?: string;
  operator?: string;
  [key: string]: unknown;
}

const stateStore = new InMemoryStateStore(); // shared across requests

// Idempotency — required for any AdCP-3-compliant seller that accepts
// mutating requests. `createIdempotencyStore` throws if `ttlSeconds` is
// outside the spec bounds (3600–604800).
const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // pgBackend(pool) for production
  ttlSeconds: 86400, // 24 hours
});

class MySeller implements DecisioningPlatform<{}, MySellerMeta> {
  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    pricingModels: ['cpm'] as const,
    channels: ['display'] as const,
    config: {},
  };

  accounts: AccountStore<MySellerMeta> = {
    // accounts.resolve runs BEFORE idempotency / handler dispatch. If it
    // returns null for a valid-shape reference, every mutating request
    // short-circuits as ACCOUNT_NOT_FOUND — which masks idempotency
    // conformance (missing-key / replay tests fail with the wrong code).
    // Handle BOTH branches of AccountReference:
    //   { account_id } — your own persisted accounts.
    //   { brand: { domain }, operator } — the canonical spec shape.
    //     Conformance storyboards use this by default (e.g. brand.domain
    //     "acmeoutdoor.example", operator "pinnacle-agency.example").
    resolve: async (ref, ctx) => {
      if ('account_id' in ref) {
        const acc = await stateStore.get('accounts', ref.account_id);
        return acc ?? null;
      }
      if ('brand' in ref && ref.brand?.domain && ref.operator) {
        // Dev/compliance mode: auto-materialize for any valid brand+operator
        // so conformance tests reach the handler. Production replaces this
        // with a real lookup against your tenant registry; returning null
        // for unknown tenants surfaces ACCOUNT_NOT_FOUND correctly.
        return {
          id: `${ref.operator}:${ref.brand.domain}`,
          operator: ref.operator,
          ctx_metadata: { brand: ref.brand.domain, operator: ref.operator },
        };
      }
      return null;
    },
    upsert: async (params, ctx) => {
      /* sync_accounts impl */
      return { ok: true, items: [] };
    },
    list: async (params, ctx) => ({ items: [], nextCursor: null }),
  };

  sales: SalesPlatform<MySellerMeta> = {
    getProducts: async (req, ctx) => {
      return { products: PRODUCTS, sandbox: true };
      // productsResponse() auto-applied by framework
    },

    createMediaBuy: async (req, ctx) => {
      // Governance check for financial commitment. The publisher's
      // governance URL rides on Account.ctx_metadata so any per-tenant
      // override is read at request time.
      const govUrl = ctx.account?.ctx_metadata?.governanceUrl;
      if (typeof govUrl === 'string') {
        const gov = await checkGovernance({
          agentUrl: govUrl,
          planId: (req as { plan_id?: string }).plan_id ?? 'default',
          caller: 'https://my-agent.com/mcp',
          tool: 'create_media_buy',
          payload: req,
        });
        if (!gov.approved) return governanceDeniedError(gov);
      }

      // Use randomUUID (not Date.now) so ids are unguessable — a guessable
      // media_buy_id lets another buyer probe or cancel. Same applies to
      // any seller-issued id (package_id, creative_id, etc.).
      // `currency` + `total_budget` are REQUIRED on get_media_buys response
      // rows. The request carries them under `total_budget: { amount, currency }`.
      // Flatten to top-level fields at create time — storing only
      // `packages[].budget` and reconstructing later fails schema validation
      // in get_media_buys/update_media_buy.
      const totalBudget = req.total_budget;
      const currency = typeof totalBudget === 'object' && totalBudget ? (totalBudget.currency ?? 'USD') : 'USD';
      const amount =
        typeof totalBudget === 'object' && totalBudget
          ? (totalBudget.amount ?? 0)
          : typeof totalBudget === 'number'
            ? totalBudget
            : 0;

      const buy = {
        media_buy_id: `mb_${randomUUID()}`,
        status: 'pending_creatives' as const,
        currency,
        total_budget: amount,
        packages:
          req.packages?.map(pkg => ({
            package_id: `pkg_${randomUUID()}`,
            product_id: pkg.product_id,
            pricing_option_id: pkg.pricing_option_id,
            budget: pkg.budget,
          })) ?? [],
      };
      await ctx.store.put('media_buys', buy.media_buy_id, buy);
      return buy; // mediaBuyResponse() auto-applied (sets revision, confirmed_at, valid_actions)
    },

    updateMediaBuy: async (mediaBuyId, patch, ctx) => {
      const existing = await ctx.store.get('media_buys', mediaBuyId);
      if (!existing) {
        return adcpError('MEDIA_BUY_NOT_FOUND', {
          message: `No media buy with id ${mediaBuyId}`,
          field: 'media_buy_id',
        });
      }
      // Only merge the fields you want to persist — do NOT spread `patch`
      // wholesale. The patch carries envelope fields (idempotency_key,
      // context) that have no business in your domain state. Spreading
      // them pollutes `get_media_buys` responses and breaks dedup.

      // State machine: creative_assignments arriving advances pending_creatives.
      // pending_creatives → pending_start (start_time in future) or active (start_time now/past).
      let status = existing.status as string;
      if (patch.paused === true) {
        status = 'paused';
      } else if (
        status === 'pending_creatives' &&
        (patch.packages ?? []).some((p: { creative_assignments?: unknown[] }) =>
          (p.creative_assignments ?? []).length > 0)
      ) {
        const startTime = existing.start_time ? new Date(existing.start_time) : null;
        status = startTime && startTime > new Date() ? 'pending_start' : 'active';
      } else if (status === 'paused') {
        status = 'active';
      }

      const updated = { ...existing, status };
      await ctx.store.put('media_buys', mediaBuyId, updated);
      return {
        media_buy_id: mediaBuyId,
        status: updated.status as 'paused' | 'active' | 'pending_start',
        // `affected_packages` is `Package[]` (per `/schemas/latest/core/package.json`)
        // — objects with at minimum `package_id`. Don't return bare strings;
        // the update-media-buy-response oneOf discriminates against them and
        // the error looks like `/affected_packages/0: must be object`.
        affected_packages: (existing.packages ?? []).map((p: { package_id: string }) => ({
          package_id: p.package_id,
        })),
      };
    },

    getMediaBuys: async (params, ctx) => {
      const result = await ctx.store.list('media_buys');
      return { media_buys: result.items };
    },

    getMediaBuyDelivery: async (filter, ctx) => {
      /* ... */
      return {
        currency: 'USD',
        reporting_period: {
          start: filter.start_date ?? '2026-01-01',
          end: filter.end_date ?? '2026-01-31',
        },
        media_buy_deliveries: [],
      };
    },

    listCreativeFormats: async (params, ctx) => ({ formats: [] }),

    // Response is `creatives: [{ creative_id, action }]` per the spec response
    // schema — NOT `synced_creatives`. v6 takes the creatives array directly;
    // the framework unpacks the request envelope.
    syncCreatives: async (creatives, ctx) =>
      creatives.map(c => ({
        creative_id: (c as { creative_id?: string }).creative_id ?? `cr_${randomUUID()}`,
        action: 'created' as const,
      })),
  };
}

const platform = new MySeller();

function createAgent({ taskStore }: ServeContext) {
  return createAdcpServerFromPlatform(platform, {
    name: 'My Seller Agent',
    version: '1.0.0',
    taskStore,
    stateStore,
    idempotency,
    // Principal scoping for idempotency. MUST never return undefined — or
    // every mutating request rejects as SERVICE_UNAVAILABLE. A constant is
    // fine for a demo; for multi-tenant production use `ctx.account.id`.
    resolveSessionKey: () => 'default-principal',
  });
}

serve(createAgent);
```

Key points:

1. Single `.ts` file — one `DecisioningPlatform` class passed to `createAdcpServerFromPlatform`
2. `get_adcp_capabilities` is auto-generated from your handlers — don't register it manually (idempotency capability is auto-declared too)
3. Response builders are auto-applied — just return the data
4. Use `ctx.store` for state — persists across stateless HTTP requests
5. Set `sandbox: true` on all mock/demo responses
6. Use `adcpError()` for business validation failures — see the error-code matrix in § create_media_buy above
7. Use `as const` on string literal arrays and union-typed fields in product definitions — TypeScript infers `string[]` from `['display', 'olv']` but the SDK requires specific union types like `MediaChannel[]`. Apply `as const` to `channels`, `delivery_type`, `selection_type`, and `pricing_model` values.
8. `pending_creatives` is a transient state — `update_media_buy` MUST advance it to `pending_start` or `active` when `creative_assignments` arrive (see state-machine logic in § update_media_buy above)

## Governance

The Implementation example above already shows the baseline `checkGovernance()` call on `create_media_buy`. This section covers the regulated-category flow: when a buyer's governance plan marks a media buy as requiring human review, you MUST route it to a human approver before committing spend.

### GDPR Art 22 / EU AI Act — when to require human review

**Why.** GDPR Article 22 bars fully automated decisions with legal or similarly significant effect on the data subject in certain contexts. The EU AI Act classifies some advertising use cases as Annex III high-risk — employment ads, credit offers, housing, insurance, education. For regulated verticals, fully automated media buys are non-compliant; the seller must put a human in the loop and preserve the decision record.

The buyer signals this by setting `plan.human_review_required: true` on the governance plan. AdCP 3.0 GA made this the canonical field — replacing `budget.authority_level: 'human_required'` from earlier drafts.

**Seller obligation.** On `create_media_buy`:

1. Read `plan.human_review_required` from the buyer's governance plan (which you already fetched / synced via `sync_plans` or the inbound governance check).
2. If `true` — enqueue the buy for human approval and return `status: 'submitted'` with a `task_id` the buyer can poll. Do NOT execute the buy until an approver signs off.
3. On approval, construct the override artifact with `buildHumanOverride({ reason, approver, approvedAt })` and persist it alongside the completed buy. The override is the compliance evidence that a human authorized the automated path.
4. If `false` — proceed with the normal `checkGovernance()` flow and commit.

### Worked example

```typescript
import {
  createAdcpServerFromPlatform,
  serve,
  adcpError,
  buildHumanOverride,
  checkGovernance,
  governanceDeniedError,
  taskToolResponse,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
  type AdcpStateStore,
} from '@adcp/sdk/server';
import { randomUUID } from 'node:crypto';

interface RegulatedMeta {
  governanceUrl?: string;
  [key: string]: unknown;
}

class RegulatedPublisher implements DecisioningPlatform<{}, RegulatedMeta> {
  capabilities = {
    specialisms: ['sales-guaranteed'] as const,
    pricingModels: ['cpm'] as const,
    channels: ['display'] as const,
    config: {},
  };

  accounts: AccountStore<RegulatedMeta> = {
    resolve: async ref => db.findAccount(ref),
    upsert: async () => ({ ok: true, items: [] }),
    list: async () => ({ items: [], nextCursor: null }),
  };

  sales: SalesPlatform<RegulatedMeta> = {
    getProducts: async () => ({ products: [] }),

    createMediaBuy: async (req, ctx) => {
      if (!ctx.account) {
        return adcpError('ACCOUNT_NOT_FOUND', { field: 'account' });
      }
      const plan = await ctx.store.get('governance_plans', (req as { plan_id?: string }).plan_id ?? '');
      if (!plan) return adcpError('PLAN_NOT_FOUND', { field: 'plan_id' });

      // Human-review gate — GDPR Art 22 / EU AI Act Annex III.
      if (plan.human_review_required === true) {
        const taskId = `task_${randomUUID()}`;
        await ctx.store.put('pending_reviews', taskId, {
          plan_id: (req as { plan_id?: string }).plan_id,
          params: req,
          enqueued_at: new Date().toISOString(),
          account_id: ctx.account.id,
          // Buyer's webhook target for async completion, if they supplied one.
          webhook_url: (req as { push_notification_config?: { url: string } }).push_notification_config?.url,
        });
        // Route this task_id to your human-review queue (Slack approval,
        // ops ticket, internal UI — whatever your reviewers use).
        await humanReviewQueue.enqueue(taskId);
        // Submitted envelope per CreateMediaBuySubmitted. Do NOT return a
        // populated MediaBuy here — media_buy_id and packages land on the
        // completion artifact once a human approves. taskToolResponse bypasses
        // the default mediaBuyResponse wrap, which would stamp revision /
        // confirmed_at / valid_actions — fields that don't belong on a task
        // envelope.
        return taskToolResponse({ status: 'submitted', task_id: taskId });
      }

      // Non-regulated path — normal governance check, commit synchronously.
      const govUrl = ctx.account.ctx_metadata?.governanceUrl;
      if (typeof govUrl === 'string') {
        const gov = await checkGovernance({
          agentUrl: govUrl,
          planId: (req as { plan_id?: string }).plan_id ?? 'default',
          caller: 'https://my-publisher.com/mcp',
          tool: 'create_media_buy',
          payload: req,
        });
        if (!gov.approved) return governanceDeniedError(gov);
      }
      return executeBuy(req, ctx.store);
    },

    updateMediaBuy: async (id, patch) => ({ media_buy_id: id, status: 'active' }),
    getMediaBuys: async () => ({ media_buys: [] }),
    getMediaBuyDelivery: async () => ({ deliveries: [] }),
    syncCreatives: async () => [],
    listCreativeFormats: async () => ({ formats: [] }),
  };
}

serve(() =>
  createAdcpServerFromPlatform(new RegulatedPublisher(), {
    name: 'Regulated Publisher',
    version: '1.0.0',
  })
);

// Called by the human-review UI when a reviewer signs off. Lives outside any
// request handler, so it takes its own AdcpStateStore — the same instance you
// passed to the framework via `stateStore` option. No ctx in scope here.
async function onHumanApproval(store: AdcpStateStore, taskId: string, approver: string, reason: string): Promise<void> {
  const pending = await store.get('pending_reviews', taskId);
  if (!pending) throw new Error(`No pending review with id ${taskId}`);

  // Validates reason ≥ 20 chars, approver as email, no control chars,
  // ISO 8601 approved_at.
  const override = buildHumanOverride({
    reason,
    approver,
    approvedAt: new Date(),
  });

  const buy = await executeBuy(pending.params, store);
  await store.put('media_buys', buy.media_buy_id, {
    ...buy,
    human_override: override,
    plan_id: pending.plan_id,
    account_id: pending.account_id,
  });
  await store.delete('pending_reviews', taskId);

  // Notify the buyer. Two options, pick based on what your server wires up:
  //   1. If you configured `webhooks` on the framework server and the buyer sent
  //      push_notification_config.url, POST the completion event from the
  //      emitter built at boot (hoisted outside the framework constructor so it's
  //      reachable here). See § Guaranteed delivery / IO signing for the
  //      emitter construction.
  //   2. Otherwise the buyer polls — they already have the task_id and will
  //      discover the committed buy via get_media_buys once it lands in
  //      'media_buys'.
}
```

### Decision table

| Plan shape                                                                 | `human_review_required` | Who approves         | Artifact required                               |
| -------------------------------------------------------------------------- | ----------------------- | -------------------- | ----------------------------------------------- |
| General consumer CPG, travel, retail                                       | `false` (or absent)     | Automated governance | `governance_context` echoed through lifecycle   |
| Employment, credit, housing, insurance, education (Annex III high-risk)    | `true` (required)       | Human reviewer       | `human_override` built via `buildHumanOverride` |
| Fair-housing, fair-lending, fair-employment, pharmaceutical (US regulated) | `true` (required)       | Human reviewer       | `human_override` built via `buildHumanOverride` |
| Explicit `policy_ids: ['eu_ai_act_annex_iii']`                             | `true` (required)       | Human reviewer       | `human_override` built via `buildHumanOverride` |

`REGULATED_HUMAN_REVIEW_CATEGORIES` (exported from `@adcp/sdk`) is the client-side minimum: `['fair_housing', 'fair_lending', 'fair_employment', 'pharmaceutical_advertising']`. `ANNEX_III_POLICY_IDS` is `['eu_ai_act_annex_iii']`. Governance agents resolve synonyms and per-publisher extensions server-side; these constants exist so pre-submit validation doesn't round-trip. Extend with your own vertical list if needed.

### Pitfalls

- Don't silently flip `human_review_required: true → false` on re-sync without `buildHumanOverride`. That's a compliance violation — the whole point of the field is that downgrades require documented human authorization.
- `buildHumanOverride` throws if `reason` trims to fewer than 20 characters, if `approver` fails the email regex, if either has control characters, or if `approvedAt` isn't a `Date` / parseable ISO 8601 string. Validate your UI's approval form against the same rules.
- Thread `governance_context` through `create_media_buy` → `update_media_buy` → delivery / lifecycle events. Dropping it breaks the audit chain — downstream governance checks need the opaque token to reconcile decisions.

<a name="idempotency"></a>

## Idempotency

AdCP v3 requires an `idempotency_key` on every mutating request. For sellers, that's `create_media_buy`, `update_media_buy`, `sync_creatives`, and any `sync_*` tools you implement. Idempotency is wired in the Implementation example above — this section explains what the framework does for you and the subtleties to know.

**What the framework handles when you pass `idempotency` to `createAdcpServerFromPlatform`:**

- Rejects missing or malformed `idempotency_key` with `INVALID_REQUEST`. The spec pattern is `^[A-Za-z0-9_.:-]{16,255}$` — a test key like `"key1"` will be rejected for length, not idempotency logic. **Ordering gotcha**: idempotency runs AFTER `resolveAccount`. If your `resolveAccount` returns null for a valid-shape reference, the buyer gets `ACCOUNT_NOT_FOUND` — NOT the missing-key error they expected — and conformance tests fail with the wrong code. Either handle both AccountReference branches (see Implementation above) or accept dev-mode brand+operator wildcards so compliance graders reach the idempotency layer.
- Hashes the request payload with RFC 8785 JCS. The emitted error codes and their semantics are in the table at [§ Composing OAuth, signing, and idempotency](#composing-oauth-signing-and-idempotency).
- Injects `replayed: true` on `result.structuredContent.replayed` when returning a cached response; fresh executions omit the field.
- Auto-declares `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities`.
- Only caches successful responses — errors re-execute on retry so transient failures don't lock into the cache. This applies to every `recovery` class including `terminal`: the AdCP terminal catalog (`ACCOUNT_SUSPENDED`, `BUDGET_EXHAUSTED`, `ACCOUNT_PAYMENT_REQUIRED`, `ACCOUNT_SETUP_REQUIRED`) is mostly state-dependent, and caching would return stale errors after the buyer remediates. Only `UNSUPPORTED_FEATURE` and `ACCOUNT_NOT_FOUND` are truly immutable, and re-executing them is cheap.
- Atomic claim on `check()` so concurrent retries with a fresh key don't all race to execute side effects.

**Handler contract: mutate last.** The framework releases the idempotency claim on ANY error path — `return adcpError(...)`, `throw adcpError(...)` (auto-unwrapped by the dispatcher), and uncaught exceptions all release. A handler that writes state then errors will double-write on retry:

```typescript
// BROKEN: write happens, error releases claim, retry re-writes
await db.insert(mediaBuy);
if (!budgetApproved) return adcpError('BUDGET_EXHAUSTED', { ... });  // claim released, insert already persisted

// CORRECT: validate first, write last
if (!budgetApproved) return adcpError('BUDGET_EXHAUSTED', { ... });  // no write yet, safe to release
await db.insert(mediaBuy);
return mediaBuyResponse({ ... });
```

If the validation can only run after a partial write (rare), make the write itself idempotent — natural-key upsert or the `ctx.store.get` → merge pattern — so re-execution converges on the same state.

**Scoping**: the principal comes from `resolveSessionKey` (or override with `resolveIdempotencyPrincipal(ctx, params, toolName)` for per-tool custom scopes). Two callers with the same principal share a cache namespace; different principals are isolated.

**Two things to know**:

1. `ttlSeconds` must be `3600` (1h) to `604800` (7d) — out of range throws at `createIdempotencyStore` construction. Don't pass minutes thinking they're seconds.
2. If you register mutating handlers without passing `idempotency`, the framework logs an error at server-creation time (v3 non-compliance). Silence it by either wiring idempotency or setting `capabilities.idempotency.replay_ttl_seconds` in your config (declares non-compliance to buyers).

**Buyer-side crash recovery.** When your buyers' processes die mid-retry they need to know whether to re-send. Point them at [`docs/guides/idempotency-crash-recovery.md`](../../docs/guides/idempotency-crash-recovery.md) — worked recipe for natural-key lookup, `IdempotencyConflictError` / `IdempotencyExpiredError`, and `metadata.replayed` as the side-effect gate.

**Known grader limitation (tracked upstream as [#678](https://github.com/adcontextprotocol/adcp-client/issues/678)).** The `idempotency` storyboard's missing-key step probes your agent with a raw HTTP POST (bypassing the SDK's `idempotency_key` auto-injection) but may not negotiate the MCP Streamable HTTP `Accept` header correctly, returning `Not Acceptable: Client must accept both application/json and text/event-stream` instead of the expected `INVALID_REQUEST`. This is a grader-side issue — your framework wiring is still correct, it'll pass once #678 lands. Ignore this specific sub-step failure in the interim.

## Going to Production

The quick-start uses `memoryBackend()` + `InMemoryStateStore` — both reset on process restart and don't scale across replicas. Production swaps three pieces: `createIdempotencyStore({ backend: pgBackend(pool) })`, `PostgresStateStore(pool)`, `PostgresTaskStore(pool)`. Run the three migrations at boot (`getIdempotencyMigration()`, `getAdcpStateMigration()`, `MCP_TASKS_MIGRATION`), wire `cleanupExpiredIdempotency(pool)` on an hourly cron, and set `resolveAccount` to hit your real DB instead of `InMemoryStateStore`. Full worked example with Pool sizing and multi-tenant principal resolution lives in [`docs/guides/BUILD-AN-AGENT.md`](../../docs/guides/BUILD-AN-AGENT.md) § Going to Production.

**Critical: probe the pool at boot.** `pg.Pool` is lazy — `new Pool({ connectionString })` does not validate the URL. A bad `DATABASE_URL` lets the server start, advertise `IdempotencySupported`, and then silently fail every mutating call. Wire `readinessCheck` on `serve()` so the server never accepts traffic with a broken pool:

```ts
const store = createIdempotencyStore({ backend: pgBackend(pool), ttlSeconds: 86400 });
pool.on('error', err => console.error('pg pool error', err)); // prevent crash on idle-client errors
serve(createAgent, {
  readinessCheck: () => store.probe(), // throws with a descriptive error if pool/table is broken
});
```

Auth is not wired in the example — see [§ Protecting your agent](#protecting-your-agent) below.

## Deployment beyond single-host HTTP

`serve(createAgent, { port, authenticate })` is sufficient for single-host HTTP — including every compliance storyboard. For other deployment shapes (multi-host, Express composition with OAuth Authorization Server routes, stdio, per-host OAuth), see [`deployment.md`](./deployment.md) — covers `createExpressAdapter`, multi-host dispatch, `resolveHost`, per-host OAuth providers, and the stdio transport.

<a name="protecting-your-agent"></a>

## Protecting your agent

**An AdCP agent that accepts unauthenticated requests is non-compliant.** The compliance runner enforces this via the `security_baseline` storyboard (every agent regardless of specialism). You MUST pick at least one of:

- **API key** — static bearer tokens looked up in your database or a constant map. Best for B2B integrations with a known counterparty.
- **OAuth 2.0** — JWTs signed by an IdP (WorkOS, Auth0, Clerk, Okta, a self-hosted authorization server). Best when buyers authenticate as themselves.
- **Both** — accept either at runtime via `anyOf(verifyApiKey(...), verifyBearer(...))`.

Ask the operator which mechanism they want before generating code. "API key, OAuth, or both?" is the first question.

### API key

```typescript
import { serve } from '@adcp/sdk';
import { verifyApiKey } from '@adcp/sdk/server';

serve(createAgent, {
  authenticate: verifyApiKey({
    verify: async token => {
      const row = await db.api_keys.findUnique({ where: { token } });
      if (!row) return null; // framework replies 401 with WWW-Authenticate
      return { principal: row.account_id };
    },
  }),
});
```

For local development use the static `keys` map: `verifyApiKey({ keys: { sk_test: { principal: 'dev' } } })`.

### OAuth

```typescript
import { serve } from '@adcp/sdk';
import { verifyBearer } from '@adcp/sdk/server';

const AGENT_URL = 'https://my-agent.example.com/mcp';

serve(createAgent, {
  publicUrl: AGENT_URL, // canonical RFC 8707 audience
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: AGENT_URL, // MUST equal publicUrl
  }),
  protectedResource: {
    authorization_servers: ['https://auth.example.com'],
    scopes_supported: ['read', 'write'],
  },
});
```

Set `publicUrl` to the canonical https:// URL clients use — the framework serves `/.well-known/oauth-protected-resource/mcp` with that exact `resource` value, and the JWT `audience` check rejects tokens minted for any other URL. Deriving the resource URL from `publicUrl` (not the incoming `Host` header) is what stops a phishing attacker from making your server advertise `https://evil.example/mcp` as the audience.

### Both

```typescript
import { serve } from '@adcp/sdk';
import { verifyApiKey, verifyBearer, anyOf } from '@adcp/sdk/server';

serve(createAgent, {
  publicUrl: AGENT_URL,
  authenticate: anyOf(verifyApiKey({ verify: lookupApiKey }), verifyBearer({ jwksUri, issuer, audience: AGENT_URL })),
  protectedResource: { authorization_servers: [issuer] },
});
```

### Compliance checklist

The `security_baseline` storyboard verifies:

1. Unauthenticated request → MUST return 401 (or 403) with a `WWW-Authenticate: Bearer ...` header. The framework does this for you when `authenticate` returns `null` or throws.
2. At least one of API-key or OAuth discovery must succeed.
3. If OAuth is advertised, the `resource` field in `/.well-known/oauth-protected-resource` MUST match the URL being called. Set `publicUrl` once — the framework enforces this automatically.

## Validate Locally

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). The commands below cover what a seller agent specifically needs.

**Boot the agent:**

```bash
npx tsx agent.ts &
```

**Happy-path conformance (storyboard runner):**

```bash
# Full seller lifecycle
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp media_buy_seller --auth $TOKEN

# Your specialism bundle (one of: sales_guaranteed, sales_non_guaranteed,
# sales_broadcast_tv, sales_streaming_tv, sales_social, sales_proposal_mode)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp sales_guaranteed --auth $TOKEN

# Cross-cutting obligations — every seller must pass these
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --storyboards idempotency,security_baseline,schema_validation,error_compliance --auth $TOKEN

# Webhook conformance (if you claim async task lifecycles)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp webhook_emission \
  --webhook-receiver --auth $TOKEN
```

**Rejection-surface conformance (property-based fuzzer — catches crashes on edge inputs):**

```bash
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp \
  --tools get_products,get_media_buys,list_creative_formats \
  --auth-token $TOKEN
```

**Request signing (if you claim `signed-requests`):** point `adcp grade request-signing` at your sandbox — see [VALIDATE-YOUR-AGENT.md § Request signing](../../docs/guides/VALIDATE-YOUR-AGENT.md#request-signing--adcp-grade-request-signing).

**Multi-instance (before production):** run with two `--url` flags to catch `(brand, account)`-scoped state that lives per-process. See [VALIDATE-YOUR-AGENT.md § Multi-instance](../../docs/guides/VALIDATE-YOUR-AGENT.md#multi-instance-testing).

Common failure decoder:

- `response_schema` → response doesn't match Zod schema
- `field_present` → required field missing
- `mcp_error` → check tool registration (schema, name)
- `authority_level` / `human_review_required` mismatch → check governance plan shape — schema moved in AdCP 3.0 GA

**Keep iterating until all steps pass.** If you can't bind ports locally, skip `tsx agent.ts` and run `npm run compliance:skill-matrix -- --filter seller` — it builds an isolated sandbox and grades end-to-end.

## Storyboards

| Storyboard                      | Use case                                               |
| ------------------------------- | ------------------------------------------------------ |
| `media_buy_seller`              | Full lifecycle — every seller should pass this         |
| `media_buy_non_guaranteed`      | Auction flow with bid adjustment                       |
| `media_buy_guaranteed_approval` | IO approval workflow                                   |
| `media_buy_proposal_mode`       | AI-generated proposals                                 |
| `media_buy_catalog_creative`    | Catalog sync + conversions                             |
| `schema_validation`             | Schema compliance + date validation errors             |
| `deterministic_testing`         | State machine correctness via `comply_test_controller` |

## Common Mistakes

| Mistake                                                    | Fix                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Using `createTaskCapableServer` + `server.tool()`          | Use `createAdcpServerFromPlatform(platform, opts)` — handles schemas, response builders, capabilities, ctx_metadata round-trip, idempotency-principal synthesis                       |
| Calling `createAdcpServer` directly in new code            | Reach for `createAdcpServerFromPlatform` first; `createAdcpServer` lives at `@adcp/sdk/server/legacy/v5` for mid-migration / escape-hatch use only                                    |
| Using module-level Maps for state                          | Use `ctx.store` — persists across HTTP requests, swappable for postgres                                                                                                               |
| Return raw JSON without response builders                  | The framework auto-applies response builders — just return the data                                                                                                                  |
| Missing `brand`/`operator` in sync_accounts response       | Echo them back from the request — they're required                                                                                                                                    |
| sync_governance returns wrong shape                        | Must include `status: 'synced'` and `governance_agents` array                                                                                                                         |
| `sandbox: false` on mock data                              | Buyers may treat mock data as real                                                                                                                                                    |
| Returns raw JSON for validation failures                   | Use `adcpError('INVALID_REQUEST', { message })` — storyboards validate the `adcp_error` structure                                                                                     |
| IO-signing setup URL at top level of media buy response    | Nest it in `account.setup`: `{ account: { setup: { url, message } } }`. Response builders reject a top-level `setup` at runtime.                                                      |
| Bypassing response builders and forgetting `valid_actions` | `mediaBuyResponse` and `updateMediaBuyResponse` auto-populate `valid_actions` from `status` — use them. For `get_media_buys`, populate each buy with `validActionsForStatus(status)`. |
| Missing `publisher_properties` or `format_ids` on Product  | Both are required — see product example in `get_products` section                                                                                                                     |
| format_ids in products don't match list_creative_formats   | Buyers echo format_ids from products into sync_creatives — if your validation rejects your own format_ids, the buyer can't fulfill creative requirements                              |
| Missing `@types/node` in devDependencies                   | `process.env` doesn't resolve without it — see Setup section                                                                                                                          |
| Dropping `context` from responses                          | Echo `args.context` back unchanged in every response — buyers use it for correlation                                                                                                  |
| `channels` typed as `string[]` instead of `MediaChannel[]` | Use `as const` on channel arrays: `channels: ['display', 'olv'] as const`. TypeScript infers `string[]` from array literals, but the SDK requires the `MediaChannel` union type.      |

### Translating storyboard runner output

When `adcp storyboard run <url> <storyboard> --json` reports a failure, the `details` / `error` strings fall into these categories:

| Storyboard signal                                 | What it means                                                             | Fix                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `✗ Response matches <tool>-response.json schema`  | Your return shape doesn't match the spec response schema                  | Return fields the schema requires; don't add top-level fields the schema rejects                           |
| `✗ field_present` (path: …)                       | Required field missing or at the wrong path                               | Check the spec's `*-response.json` for the field; common miss: `context.correlation_id` not echoed back    |
| `✗ field_value` expected X got Y                  | Value mismatch on a specific path                                         | Most often `context.correlation_id` drift or a status enum value that's stale                              |
| `mcp_error -32602: Input validation error`        | SDK Zod schema rejected the **incoming** request — your handler never ran | Drift between the SDK schema and the storyboard yaml. File upstream if the storyboard is authoritative     |
| `Agent did not advertise tool "X"` (as a warning) | Storyboard expects a tool you haven't registered                          | Register the tool; if it lives in another agent (e.g., governance tools from a seller), ignore the warning |
| Missing `idempotency_key` → handler never runs    | Mutating request without an idempotency key                               | SDK rejects at the idempotency layer. File runner bug if the storyboard yaml's `sample_request` omits it   |

## Specialism Details

Each specialism below has a companion file with its delta on top of the baseline. Fetch only the one you are building.

| Specialism             | Status  | Companion file                                                                                                        |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `sales-guaranteed`     | stable  | [`specialisms/sales-guaranteed.md`](./specialisms/sales-guaranteed.md)                                                |
| `sales-non-guaranteed` | stable  | [`specialisms/sales-non-guaranteed.md`](./specialisms/sales-non-guaranteed.md)                                        |
| `sales-broadcast-tv`   | stable  | [`specialisms/sales-broadcast-tv.md`](./specialisms/sales-broadcast-tv.md)                                            |
| `sales-streaming-tv`   | preview | baseline only                                                                                                         |
| `sales-social`         | stable  | [`specialisms/sales-social.md`](./specialisms/sales-social.md)                                                        |
| `sales-exchange`       | preview | baseline only                                                                                                         |
| `sales-proposal-mode`  | stable  | [`specialisms/sales-proposal-mode.md`](./specialisms/sales-proposal-mode.md)                                          |
| `audience-sync`        | stable  | [`specialisms/audience-sync.md`](./specialisms/audience-sync.md)                                                      |
| `signed-requests`      | preview | [`specialisms/signed-requests.md`](./specialisms/signed-requests.md) — cross-cutting; applies to every mutating agent |

Claim exactly the specialisms your agent actually implements in `capabilities.specialisms`. Don't claim a specialism you only partially support — the compliance storyboard for that specialism will fail hard.

## Reference

- `docs/guides/BUILD-AN-AGENT.md` — `createAdcpServerFromPlatform` patterns, async tools, state persistence
- `docs/llms.txt` — full protocol reference
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `storyboards/media_buy_seller.yaml` — full buyer interaction sequence
- `examples/error-compliant-server.ts` — seller with error handling
- `src/lib/server/create-adcp-server.ts` — framework source (for TypeScript autocomplete exploration)
