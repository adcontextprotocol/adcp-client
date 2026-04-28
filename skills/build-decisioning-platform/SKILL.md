---
name: build-decisioning-platform
description: Use when building an AdCP seller, creative, or audience agent against the v6.0 DecisioningPlatform shape (alpha). One interface, four async patterns, no AsyncOutcome ceremony — just `Promise<T>` and `throw AdcpError`.
---

# Build a Decisioning Platform (v6.0 alpha)

> **Status: PREVIEW.** The v6.0 framework refactor lands behind
> `createAdcpServerFromPlatform`. The legacy v5.x handler-style API
> (`createAdcpServer({ mediaBuy: { ... } })`) remains the production
> path until v6.0 GA. Build new agents against this skill if you want
> the cleaner shape; the legacy path is at `skills/build-seller-agent/`.

## Overview

A `DecisioningPlatform` is a single TypeScript class implementing per-specialism interfaces:

- `sales: SalesPlatform` — `sales-non-guaranteed`, `sales-guaranteed`, retail-media, etc.
- `creative: CreativeTemplatePlatform | CreativeGenerativePlatform`
- `audiences: AudiencePlatform`
- (v1.1) `governance`, `brand`, `signals`

The framework owns wire mapping, account resolution, idempotency, signing, async tasks, status normalization, and lifecycle state. You write the business decisions.

## The canonical adopter shape

Minimal copy-paste-runnable example. Single tenant, one product, sync `create_media_buy`. Substitute your real lookups inside the bodies.

```ts
import {
  AdcpError,
  createAdcpServerFromPlatform,
  type SalesPlatform,
  type AccountStore,
} from '@adcp/client/server/decisioning';

// Don't annotate `platform: DecisioningPlatform` — let TS infer the
// `specialisms: ['sales-non-guaranteed']` literal so RequiredPlatformsFor
// narrows the constraint to "must provide sales: SalesPlatform".
const platform = {
  capabilities: {
    specialisms: ['sales-non-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://creative.example.com/mcp' }],
    channels: ['display'] as const,
    pricingModels: ['cpm'] as const,
    config: {},
  },

  // Single-tenant: one synthetic account; framework still routes everything
  // through resolve(). See § "accounts.resolve() is mandatory".
  accounts: {
    resolution: 'derived',
    resolve: async () => ({
      id: 'tenant_singleton',
      name: 'My Ad Network',
      status: 'active',
      metadata: {},
      authInfo: { kind: 'api_key' },
    }),
  } satisfies AccountStore,

  sales: {
    getProducts: async (req, ctx) => ({
      products: [
        {
          product_id: 'p_homepage',
          name: 'Homepage display',
          description: 'Above-the-fold homepage display, IAB display 300x250',
          delivery_type: 'non_guaranteed',
          format_ids: [{ id: 'display_300x250', agent_url: 'https://creative.example.com/mcp' }],
          publisher_properties: [{ publisher_domain: 'publisher.example.com', selection_type: 'all' }],
          pricing_options: [{ pricing_option_id: 'cpm_5', pricing_model: 'cpm', rate: 5, currency: 'USD' }],
          reporting_capabilities: {
            available_reporting_frequencies: ['hourly', 'daily'],
            expected_delay_minutes: 30,
            timezone: 'UTC',
            supports_webhooks: false,
            available_metrics: [],
            date_range_support: 'date_range',
          },
        },
      ],
    }),
    createMediaBuy: async (req, ctx) => ({
      media_buy_id: `mb_${Date.now()}`,
      status: 'pending_creatives',
      confirmed_at: new Date().toISOString(),
      packages: [],
    }),
    updateMediaBuy: async (mediaBuyId, patch, ctx) => ({
      media_buy_id: mediaBuyId,
      status: patch.paused === true ? 'paused' : 'active',
    }),
    syncCreatives: async (creatives, ctx) =>
      creatives.map(c => ({ creative_id: c.creative_id, action: 'created' })),
    getMediaBuyDelivery: async (filter, ctx) => ({
      currency: 'USD',
      reporting_period: { start: filter.start_date ?? '2026-04-01', end: filter.end_date ?? '2026-04-30' },
      media_buy_deliveries: [],
    }),
  } satisfies SalesPlatform,
};

const server = createAdcpServerFromPlatform(platform, {
  name: 'My Ad Network',
  version: '1.0.0',
  // Plus standard createAdcpServer options: idempotency, signedRequests,
  // webhooks, validation, etc.
});

// Then mount with `serve(server)` for MCP, or createExpressAdapter for A2A.
```

What the framework wires automatically when you call `createAdcpServerFromPlatform`:

- All the AdCP wire tools your declared specialisms support (e.g., `get_products`, `create_media_buy`).
- A `tasks_get` polling tool — buyers call it with `{ task_id, account }` to poll HITL task lifecycle. You don't write this; it's there as soon as you wire any `*Task` HITL method. See "The buyer gets terminal state two ways" below for the full lifecycle shape.
- Idempotency-key replay protection on every mutating tool.
- RFC 9421 webhook signing on terminal-task push notifications (when `serve({ webhooks })` is wired).

**Three rules**:

1. Methods return `Promise<T>` directly — no `ok()` / `submitted()` / `rejected()` wrappers.
2. `throw new AdcpError(code, opts)` for buyer-facing structured rejection.
3. For HITL on tools whose wire response defines a `Submitted` arm (`create_media_buy`, `sync_creatives`): return `ctx.handoffToTask(fn)` from inside the same method. The framework allocates `task_id`, returns the spec-defined `Submitted` envelope to the buyer, and runs `fn` in the background. Hybrid sellers branch per call.

## Two async patterns

### 1. Sync happy path

The 80% case. Plain async function:

```ts
createMediaBuy: async (req, ctx) => {
  const buy = await this.platform.createOrder(req);
  return this.toMediaBuy(buy);
};
```

### 2. Structured rejection — `throw AdcpError`

```ts
createMediaBuy: async (req, ctx) => {
  // total_budget is `number | { amount?: number; currency?: string }`
  // depending on buyer shape; discriminate before access.
  const budget = typeof req.total_budget === 'number'
    ? req.total_budget
    : req.total_budget?.amount ?? 0;
  if (budget < FLOOR_BUDGET) {
    throw new AdcpError('BUDGET_TOO_LOW', {
      recovery: 'correctable',
      message: `Floor is $${FLOOR_BUDGET}`,
      field: 'total_budget',
      suggestion: `Raise total_budget to at least ${FLOOR_BUDGET}`,
    });
  }
  return /* ... your createMediaBuy success body ... */;
};
```

`AdcpError` carries `code`, `recovery`, optional `field` / `suggestion` / `retry_after` / `details`. The framework projects these onto the wire `adcp_error` envelope.

**Multi-error pre-flight** (Prebid pattern): one throw, all errors in `details.errors`:

```ts
const errors = this.preflight(req); // returns AdcpStructuredError[]
if (errors.length > 0) {
  throw new AdcpError('INVALID_REQUEST', {
    recovery: 'correctable',
    message: errors[0].message,
    field: errors[0].field,
    details: { errors },
  });
}
```

### 3. HITL — return `ctx.handoffToTask(fn)`

For tools whose wire response defines a `Submitted` arm (today: `create_media_buy`, `sync_creatives`), adopters with human-in-the-loop workflows return `ctx.handoffToTask(fn)` from inside the same method. The framework allocates `task_id`, returns the spec-defined `Submitted` envelope to the buyer immediately, then runs `fn` in the background. `fn`'s return value becomes the task's terminal artifact; `throw new AdcpError(...)` becomes the terminal error. `fn` receives a `TaskHandoffContext` with `id` (framework-issued task id), `update(progress)`, and `heartbeat()`.

```ts
sales: SalesPlatform<MyMeta> = {
  // ... other methods ...
  createMediaBuy: (req, ctx) => ctx.handoffToTask(async (taskCtx) => {
    // Persist the task_id on your side first, before waiting on a human:
    await this.queueForReview({ taskId: taskCtx.id, request: req });

    // Optional: push a status message visible to the buyer's polling.
    await taskCtx.update({ message: 'Awaiting trafficker review...' });

    // Then await the operator. Hours-to-days are fine — buyer received
    // the submitted envelope already and polls / receives webhook.
    const decision = await this.waitForOperatorApproval(req);

    if (decision.denied) {
      throw new AdcpError('GOVERNANCE_DENIED', {
        recovery: 'terminal',
        message: decision.reason,
      });
    }

    // Return → task transitions to `completed` with this as `result`
    return {
      media_buy_id: decision.media_buy_id,
      status: 'pending_creatives',
      confirmed_at: new Date().toISOString(),
      packages: [],
    };
  }),
};
```

**The buyer gets terminal state two ways:**

1. **Webhook push** — buyer included `push_notification_config: { url, token }` in the original request. Framework signs (RFC 9421) + delivers to that URL with the spec's `mcp-webhook-payload.json` envelope on terminal state. URL is validated server-side: rejects RFC 1918, loopback, link-local, CGNAT, IPv6 unique-local, alternate IPv4 forms, and IPv4-mapped IPv6 before delivery (SSRF guard). Bad URLs FAIL FAST with `INVALID_REQUEST` at the request boundary — buyers see their config error immediately, not as silent webhook drops.
2. **Polling** — framework auto-registers a `tasks_get` custom tool. Buyers call it with `{ task_id, account }` and receive the spec-flat lifecycle shape (`task_id`, `task_type`, `status`, `created_at`, `updated_at`, `completed_at` on terminal, `result` on completed, top-level `error: { code, message, details? }` on failed). Tenant-scoped — passes `account` through `accounts.resolve(ref, ctx)` and refuses cross-tenant probes with `REFERENCE_NOT_FOUND`. You don't write this tool; it's wired in by the framework. Programmatic access for ops / cron code is via `server.getTaskState(taskId, accountId)`.

**Sync-only tools that need long-running completion** use `publishStatusChange(...)` for lifecycle updates instead of HITL. The per-tool wire response schemas don't include `Submitted` arms for `update_media_buy`, `build_creative`, `sync_catalogs`, or `get_products` (a spec inconsistency tracked as [adcp#3392](https://github.com/adcontextprotocol/adcp/issues/3392) — the Submitted schemas exist but aren't rolled into each tool's response `oneOf`). Until the spec consolidates, long-running work on those tools publishes status changes (`media_buy` → `active` → `completed`) on the event bus and buyers subscribe. When adcp#3392 lands, the SDK will widen the unified shape to those tools.

## Hybrid sellers (programmatic + guaranteed in one tenant)

A real publisher commonly sells both **programmatic remnant** (sync, instant `media_buy_id`) and **guaranteed/sponsorship** (HITL, trafficker review) through the same `create_media_buy` tool. The unified shape handles this natively — branch in your method body on whatever signal determines the path (product type, buyer pre-approval, amount thresholds, etc.):

```ts
sales: SalesPlatform = {
  createMediaBuy: async (req, ctx) => {
    // Fast path: programmatic remnant, pre-approved buyer, low-risk amount.
    // Returns Success directly — buyer gets media_buy_id on the immediate response.
    if (this.isProgrammatic(req)) {
      return await this.commitSync(req);
    }
    // Slow path: guaranteed inventory, trafficker review needed.
    // Returns TaskHandoff — buyer gets { status: 'submitted', task_id }.
    return ctx.handoffToTask(async (taskCtx) => {
      await taskCtx.update({ message: 'Awaiting trafficker review' });
      return await this.waitForTrafficker(req, taskCtx.id);
    });
  },
};
```

Buyers pattern-match on the wire response shape. Predictable per request (deterministic given the products selected), dynamic per call. No latency tax on the 99% programmatic fast path; no awkward wire workarounds for the HITL slow path.

## Per-creative review (partial-batch)

`syncCreatives` returns per-creative `status`. Mix freely on the sync arm:

```ts
syncCreatives: async (creatives, ctx) => {
  return creatives.map(c => ({
    creative_id: c.creative_id,
    action: 'created',
    status: this.requiresManualReview(c) ? 'pending_review' : 'approved',
  }));
};
```

When the ENTIRE batch needs background review (Innovid, broadcast TV — 4-72h SLA), return `ctx.handoffToTask(fn)` and the framework projects the spec's `Submitted` envelope:

```ts
syncCreatives: async (creatives, ctx) => {
  if (creatives.some(c => this.needsBatchReview(c))) {
    return ctx.handoffToTask(async (taskCtx) => {
      await taskCtx.update({ message: 'S&P review pending' });
      return await this.reviewAndPersist(creatives);
    });
  }
  // Sync arm — return rows directly.
  return creatives.map(c => ({ creative_id: c.creative_id, action: 'created', status: 'approved' }));
};
```

## Buyer-driven approval as separate methods

Don't smush approval into `createMediaBuy` as a side-effect when the buyer can drive the workflow explicitly. AdCP has dedicated specialisms:

- `acquire_rights` — brand-rights specialism (`brand: BrandRightsPlatform`)
- `check_governance` — governance specialism (`governance: GovernancePlatform`, v1.1)
- `get_products` → `proposal_id` round-trips → `create_media_buy` commits

The buyer calls approval explicitly; `createMediaBuy` runs after the approval and is fast.

The escape hatch — `ctx.runAsync` + `ctx.startTask` — exists for the genuinely-opaque case where the buyer has no callable surface (GAM trafficker review where the operator's queue is internal).

## Error code vocabulary

`AdcpError`'s `code` field is `ErrorCode | (string & {})`. The 45 standard codes mirror `schemas/cache/3.0.0/enums/error-code.json`. Autocomplete works on the standard set; platform-specific codes are accepted (the `(string & {})` escape hatch).

**Misspellings warn at runtime.** `'BUDGET_TO_LOW'` (typo) compiles fine but the framework warns once per unknown code at construction. Set `ADCP_DECISIONING_ALLOW_CUSTOM_CODES=1` to silence the warn for platforms that intentionally mint vendor-specific codes (e.g., `'GAM_INTERNAL_QUOTA_EXCEEDED'`). Verify against the `ErrorCode` union before shipping.

Common codes:

- **Buyer-fixable** (`recovery: 'correctable'`): `INVALID_REQUEST`, `BUDGET_TOO_LOW`, `POLICY_VIOLATION`, `CREATIVE_REJECTED`, `MEDIA_BUY_NOT_FOUND`, `INVALID_STATE`, `REQUOTE_REQUIRED`
- **Transient** (`recovery: 'transient'`, retry with backoff): `RATE_LIMITED` (always include `retry_after`), `SERVICE_UNAVAILABLE`
- **Terminal** (`recovery: 'terminal'`, requires human action): `GOVERNANCE_DENIED`, `ACCOUNT_SUSPENDED`, `PERMISSION_DENIED`, `UNSUPPORTED_FEATURE`

Generic thrown errors (`Error`, `TypeError`) become `SERVICE_UNAVAILABLE` at the framework boundary.

## Account resolution

`accounts.resolve(ref, ctx?)` is the single tenant boundary. Three resolution modes:

| `resolution` | When to pick | What `resolve` receives |
| --- | --- | --- |
| `'explicit'` (default) | Multi-tenant; buyer passes `account_id` on every request (Snap, Meta, GAM via Network/Company id). | `ref = { account_id }` (or `{ brand, operator }`) on every call. |
| `'implicit'` | Buyer pre-syncs accounts via `sync_accounts`; subsequent calls resolved by `ctx.authInfo` lookup against pre-synced linkage (LinkedIn, some retail-media operators). | `ref` may be undefined; use `ctx.authInfo.clientId` to look up. |
| `'derived'` | Single-tenant; one logical advertiser per agent process. Auth principal alone identifies the tenant. | `ref` typically undefined; return the singleton regardless. |

**If you have one tenant, declare `resolution: 'derived'`.** The default is `'explicit'`. A single-tenant agent that omits `resolution` falls into `'explicit'` mode where tools whose buyer omits the `account` field (`provide_performance_feedback`, `list_creative_formats`, `report_usage`, `tasks_get` without explicit account) silently fail with `ACCOUNT_NOT_FOUND` because the framework expects the buyer to pass an account on those tools too.

```ts
// Multi-tenant
accounts: {
  resolution: 'explicit',
  resolve: async (ref, ctx) => {
    if (ref?.account_id) return await this.db.findById(ref.account_id);
    if (ref?.brand) return await this.db.findByBrand(ref.brand.domain, ref.operator);
    // ref undefined: tool without `account` field on wire — auth-derived path.
    if (ctx?.authInfo?.clientId) return await this.db.findByClient(ctx.authInfo.clientId);
    return null; // → ACCOUNT_NOT_FOUND
  },
} satisfies AccountStore;
```

**Use `ctx.authInfo` to authorize, not just lookup.** Don't naively `findById(ref.account_id)` — that lets an attacker passing `{ account: { account_id: 'tenant_B' } }` get tenant B's account back from a flat lookup. Cross-check that the resolved tenant is reachable from the principal in `ctx.authInfo` (e.g., the OAuth client has been granted access to that tenant). The framework wires `ctx.authInfo` automatically from `serve({ authenticate })`.

### Explicit-mode adopters MUST handle `ref === undefined`

The framework calls `accounts.resolve(undefined, { authInfo, toolName })` for every request whose wire schema lacks an `account` field — this is universal across `'explicit'`, `'implicit'`, and `'derived'` modes. The wire tools that hit this path:

- `list_creative_formats` (universal — every buyer expects it)
- `provide_performance_feedback`
- `report_usage`
- `tasks_get` when called without `account` (single-tenant case)
- `get_account_financials` (account is implicit from auth)

If your `'explicit'`-mode resolver only handles `ref?.account_id` and falls through on `undefined`, those tools get `ctx.account === undefined` and the framework returns `ACCOUNT_NOT_FOUND`. The fix is the `if (ctx?.authInfo?.clientId)` branch in the example above. Your tenants are reachable from the OAuth client / API-key principal — that's how multi-tenant SaaS auth works — so this is a code-path you already have at the auth layer; just thread it into `resolve()`.

Throwing `AccountNotFoundError` only from `resolve()` — never from specialism methods — gets the spec's fixed `ACCOUNT_NOT_FOUND` envelope. Generic throws from inside `resolve()` map to `SERVICE_UNAVAILABLE`.

### `accounts.resolve()` is mandatory — even for "no tenant" agents

The framework calls `accounts.resolve()` on every request before dispatching to a specialism method. Single-tenant agents that historically skipped account resolution (no per-buyer scoping; the agent serves one logical advertiser) MUST still implement `resolve()` — declare `resolution: 'derived'` and return a single synthetic `Account` regardless of the input ref:

```ts
accounts: AccountStore<MyMeta> = {
  resolution: 'derived', // single-tenant; auth principal alone identifies the tenant
  resolve: async () => ({
    id: 'singleton',
    name: 'My Agent',
    status: 'active',
    metadata: { /* whatever your handlers want to read off ctx.account.metadata */ },
    authInfo: { kind: 'api_key' },
  }),
};
```

Why this is non-negotiable: the resolved account is the framework's tenant boundary for idempotency keys, status-change scoping (`account_id` on every event), workflow steps, and per-tenant capability overrides via `getCapabilitiesFor(account)`. A platform without an `account` per request can't participate in any of those. Adopters migrating from a pre-v6 codebase where `accounts.resolve()` was skipped (training-agent's posture today) need to add this wrapper as part of the migration — it's ~10 lines and unblocks the rest of the framework's invariants.

### Sandbox: `AccountReference.sandbox === true`

There is no separate "dry-run" mode in v6. When the buyer sends `account.sandbox === true`, the framework calls `accounts.resolve()` with the same flag set; your resolver routes to a sandbox account, and the platform reads/writes go through your sandbox backend by reading `account.metadata`:

```ts
resolve: async (ref) => {
  if (ref.sandbox === true) {
    return { id: 'sandbox_acc', metadata: { backend: 'sandbox' }, ... };
  }
  return { id: 'prod_acc', metadata: { backend: 'production' }, ... };
}
```

Tool-specific `dry_run` flags on `sync_catalogs` and `sync_creatives` are wire fields the platform receives and honors locally — they're NOT a framework-level mode.

## OAuth provider wiring

OAuth verifiers live on `serve()`, not on the platform. The platform only sees the resolved `authInfo` via `ctx.account.authInfo` after `serve({ authenticate })` produces it:

<!-- skill-example-skip: documentation-pattern, references undeclared `server`, `parseBearerToken`, `myOAuthProvider` -->
```ts
import { serve } from '@adcp/client/server';

serve(() => server, {
  publicUrl: 'https://my-agent.example.com',
  authenticate: async ({ headers }) => {
    const token = parseBearerToken(headers.authorization);
    const principal = await myOAuthProvider.verify(token); // SnapOAuthProvider, your verifier, etc.
    if (!principal) return null; // 401
    return {
      token,
      clientId: principal.client_id,
      scopes: principal.scopes,
      extra: { sub: principal.sub, /* whatever */ },
    };
  },
});
```

The platform's `accounts.resolve()` receives this as `extra.authInfo` on the second arg context (when `serve({ authenticate })` is wired). Use it to translate the OAuth principal into your tenant model:

```ts
accounts: {
  resolve: async (ref, { authInfo }) => {
    const platformAccountId = await myUpstream.findAccountByOAuthClient(authInfo?.clientId, ref);
    return { id: platformAccountId, ... };
  },
};
```

Same pattern for stdio + http transports — `authenticate` runs at the transport boundary, the platform sees the resolved principal. There's no `auth?: AuthProvider` field on `DecisioningPlatform`; that boundary is intentionally on the surrounding `serve()` opts.

## Production task storage

The framework's default in-memory `TaskRegistry` is gated by `NODE_ENV` — refuses to construct outside `{test, development}` unless `ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1` is explicitly set. Every HITL-eligible production deployment needs a durable task registry so task state survives process restarts and load-balancer failover.

Ship `createPostgresTaskRegistry({ pool, tableName? })`:

```ts
import { Pool } from 'pg';
import {
  createAdcpServerFromPlatform,
  createPostgresTaskRegistry,
  getDecisioningTaskRegistryMigration,
} from '@adcp/client/server/decisioning';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Once at boot — idempotent CREATE TABLE IF NOT EXISTS, safe to re-run
await pool.query(getDecisioningTaskRegistryMigration());

const server = createAdcpServerFromPlatform(platform, {
  name: 'My Ad Network', version: '1.0.0',
  taskRegistry: createPostgresTaskRegistry({ pool }),
});
```

Cross-instance reads work — process A allocates the task, process B reads the lifecycle for `tasks_get`. Terminal-state idempotency is enforced via SQL `WHERE status = 'submitted'` so concurrent webhook deliveries can't race to overwrite each other. Background-completion tracking (`_registerBackground`) is process-local — promises don't serialize, so production HITL flows that span process boundaries drive completion via webhook → an explicit `complete()` / `fail()` from the receiving process.

Custom backend? Implement the `TaskRegistry` interface (8 methods) for Redis / DynamoDB / Spanner / etc. — the framework awaits each call so all 4 mutators (`create`, `complete`, `fail`, `getTask`) can be storage-backed.

**Adopter `*Task` return size cap.** Postgres-backed registries cap `result` / `error` JSONB rows at 4MB. Returns over the cap surface via `onTaskTransition` with `errorCode: 'REGISTRY_WRITE_FAILED'` and skip webhook delivery (registry state is inconsistent, so the framework refuses to push). Offload large payloads to blob storage and return references in the result body instead. The cap protects the DB write path only — adopter code that serializes `result` for logs/metrics MUST impose its own bound.

## Custom webhook emitter

Default behavior: when the host wires `webhooks` on `serve()`, the framework binds the per-request `ctx.emitWebhook` to a signed RFC 9421 path. You don't need a custom emitter unless you want a different retry policy, a different signing key for task webhooks vs. status-change webhooks, or a fake for tests.

```ts
createAdcpServerFromPlatform(platform, {
  name: 'My Ad Network', version: '1.0.0',
  taskWebhookEmitter: {
    emit: async ({ url, payload, operation_id }) => {
      // Your custom delivery — must sign per RFC 9421 if you claim
      // signed-requests. Or delegate to ctx.emitWebhook (use the default
      // path) if you only need to wrap with logging.
      return await mySigningEmitter.deliver(url, payload, operation_id);
    },
    // Required acknowledgment when your emitter does NOT sign:
    // unsigned: true,  // for dev/test fakes
  },
});
```

**Signing posture is your responsibility.** If your platform claims `signed-requests` and you wire a custom emitter without `unsigned: true`, the framework warns at construction (in non-test envs) — buyers who verify signatures will reject your unsigned webhooks. Either delegate to the framework's signing pipeline or set `unsigned: true` to acknowledge dev/test usage. Set `ADCP_DECISIONING_ALLOW_UNSIGNED_TEST_EMITTER=1` to silence the warn for staging environments where signing isn't yet wired.

## Migrating from v5.x handler-style — the merge seam

If you have a v5.x agent built on `createAdcpServer({ mediaBuy: { ... } })`, you don't need to rewrite all of it before adopting v6.0. `createAdcpServerFromPlatform` accepts the v5 handler-style domains (`mediaBuy`, `creative`, `accounts`, `eventTracking`, `signals`, `governance`, `brandRights`, `sponsoredIntelligence`) as `opts` alongside the v6 platform interface. Platform-derived handlers WIN per-key; adopter handlers fill gaps for tools the platform doesn't yet model. Migrate one specialism at a time.

The seam logs a warning when an adopter handler is shadowed by a platform-derived one — the failure mode where v6.x adds a tool to a specialism interface and your prior merge-seam override silently stops running on next deploy. Pick a `mergeSeam` mode based on your environment:

| Mode | When to pick |
| --- | --- |
| `'warn'` (default) | Local dev, mid-migration. Logs every collision at construction. |
| `'log-once'` | Multi-tenant host running N constructions per process / hot-reload dev. Logs the first time each `(domain, keys)` collision is seen, then suppresses repeats. |
| `'strict'` | CI / new deployments. Throws `PlatformConfigError` so the build fails before silent regression ships. |
| `'silent'` | Intentional override — you've audited the collision and the platform-derived handler is correct; suppress the noise. |

CI vs. local-dev side-by-side:

```ts
// CI / new deployments — fail the build on silent migration regression.
createAdcpServerFromPlatform(platform, {
  name: 'My Ad Network', version: '1.0.0',
  mergeSeam: 'strict',
  mediaBuy: { listCreativeFormats, providePerformanceFeedback, /* ... */ },
});

// Local dev / hot-reload — see every collision in the log, never crash.
createAdcpServerFromPlatform(platform, {
  name: 'My Ad Network', version: '1.0.0',
  mergeSeam: process.env.NODE_ENV === 'production' ? 'log-once' : 'warn',
  mediaBuy: { listCreativeFormats, providePerformanceFeedback, /* ... */ },
});
```

## Observability hooks

Wire any telemetry backend (DataDog / Prometheus / OpenTelemetry / structured logger) via the framework's `observability` hooks:

```ts
const server = createAdcpServerFromPlatform(platform, {
  name: 'My Ad Network', version: '1.0.0',
  observability: {
    onAccountResolve: ({ tool, durationMs, resolved, fromAuth }) => {
      // accountId is also present when resolved=true; pre-bucket if you forward it
      // (high tenant counts will explode metric tag cardinality).
      metrics.histogram('adcp.account_resolve.ms', durationMs, { tool, fromAuth, resolved: String(resolved) });
    },
    onTaskCreate: ({ tool, accountId, durationMs }) => {
      metrics.histogram('adcp.task.create.ms', durationMs, { tool });
    },
    onTaskTransition: ({ tool, status, durationMs, errorCode }) => {
      // errorCode is bucketed (ErrorCode enum + framework-synthetic
      // 'REGISTRY_WRITE_FAILED'). Safe to use as a metric tag.
      metrics.histogram('adcp.task.duration_ms', durationMs, { tool, status, errorCode: errorCode ?? 'none' });
    },
    onWebhookEmit: ({ tool, status, success, durationMs, errorCode }) => {
      // errorCode is bucketed (TIMEOUT/CONNECTION_REFUSED/HTTP_4XX/HTTP_5XX/
      // SIGNATURE_FAILURE/UNKNOWN). Don't tag on errorMessages — free-text.
      metrics.histogram('adcp.webhook.duration_ms', durationMs, { tool, status, success: String(success), errorCode: errorCode ?? 'none' });
    },
    onStatusChangePublish: ({ resourceType }) => {
      metrics.increment('adcp.status_change', { resourceType });
    },
  },
});
```

Hooks are throw-safe — adopter callback exceptions are caught and logged via the framework logger; they never break dispatch. Per-tool dispatch latency hooks (`onDispatchStart` / `onDispatchEnd`) land in v6.1 with the per-handler instrumentation pass; an opt-in `@adcp/client/telemetry/otel` peer-dep adapter ships with AdCP-aligned span / metric names.

## Reference

- Worked example: [`examples/decisioning-platform-mock-seller.ts`](../../examples/decisioning-platform-mock-seller.ts)
- Integration tests: [`test/server-decisioning-mock-seller.test.js`](../../test/server-decisioning-mock-seller.test.js)
- Design doc: [`docs/proposals/decisioning-platform-v1.md`](../../docs/proposals/decisioning-platform-v1.md)
- MCP+A2A serving: [`docs/proposals/mcp-a2a-unified-serving.md`](../../docs/proposals/mcp-a2a-unified-serving.md)
- Migration sketches: `docs/proposals/decisioning-platform-{training-agent,gam,scope3,prebid}-migration.md`

## What's not in v6.0 alpha

- Public `./server` export — `./server/decisioning` is preview-only; subject to change before v6.0 GA
- Native MCP `tasks/get` method dispatch (we ship `tasks_get` snake-case as a tool today; native method dispatch via the MCP SDK's `registerToolTask` lands in v6.1, supporting both surfaces)
- `ctx.runAsync` `maxAutoAwaitMs` cap with AbortSignal cancellation
- `getCapabilitiesFor(account)` per-tenant runtime
- `taskRegistry.transition()` for adopter-emitted intermediate states (`working`, `input-required`, `auth-required`) — v6.0 framework writes only `submitted`/`completed`/`failed`; the Postgres registry CHECK widens in v6.1
