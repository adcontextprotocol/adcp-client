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

```ts
import {
  AdcpError,
  createAdcpServerFromPlatform,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
} from '@adcp/client/server/decisioning';

class MyAdNetwork implements DecisioningPlatform<MyConfig, MyMeta> {
  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://creative.example.com/mcp' }],
    channels: ['display', 'video'] as const,
    pricingModels: ['cpm'] as const,
    config: { /* your config */ },
  };

  statusMappers = { /* native → AdCP status mapping; optional */ };

  accounts: AccountStore<MyMeta> = {
    resolve: async (ref) => /* lookup or null */,
    upsert: async (refs) => /* sync_accounts */,
    list: async (filter) => /* list_accounts with cursor */,
  };

  sales: SalesPlatform<MyMeta> = {
    getProducts: async (req, ctx) => ({ products: this.lookup(req.brief) }),
    createMediaBuy: async (req, ctx) => /* see async patterns below */,
    updateMediaBuy: async (buyId, patch, ctx) => /* mutate + return */,
    syncCreatives: async (creatives, ctx) => /* per-creative status */,
    getMediaBuyDelivery: async (filter, ctx) => /* delivery rows */,
  };
}

const server = createAdcpServerFromPlatform(new MyAdNetwork(), {
  name: 'My Ad Network',
  version: '1.0.0',
  // Plus standard createAdcpServer options: idempotency, signedRequests,
  // webhooks, validation, etc.
});

// Then mount with `serve(server)` for MCP, or createExpressAdapter for A2A.
```

**Three rules**:

1. Methods return `Promise<T>` directly — no `ok()` / `submitted()` / `rejected()` wrappers.
2. `throw new AdcpError(code, opts)` for buyer-facing structured rejection.
3. For HITL: implement `xxxTask(taskId, req, ctx)` instead of `xxx(req, ctx)`. Pick exactly one per pair (`createMediaBuy` OR `createMediaBuyTask`); `validatePlatform()` rejects defining both.

## Three async patterns

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
  if (req.total_budget.amount < this.floor) {
    throw new AdcpError('BUDGET_TOO_LOW', {
      recovery: 'correctable',
      message: `Floor is $${this.floor} CPM`,
      field: 'total_budget.amount',
      suggestion: `Raise total_budget to at least ${this.floor * 1000}`,
    });
  }
  return await this.platform.create(req);
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

### 3. HITL — implement the `*Task` variant

For tools whose wire response unions define a `Submitted` arm (today: `create_media_buy`, `sync_creatives`), adopters with human-in-the-loop workflows implement the `*Task` variant instead of the sync one. The framework allocates `taskId` BEFORE invoking your method, returns the spec-defined submitted envelope to the buyer immediately, and runs your `*Task` method in the background. Your method's return value becomes the task's terminal artifact; `throw new AdcpError(...)` becomes the terminal error.

```ts
sales: SalesPlatform<MyMeta> = {
  // ... other methods ...
  createMediaBuyTask: async (taskId, req, ctx) => {
    // Persist the task_id on your side first, before waiting on a human:
    await this.queueForReview({ taskId, request: req });

    // Then await the operator. Hours-to-days are fine — buyer received
    // the submitted envelope already and polls / receives webhook.
    const decision = await this.waitForOperatorApproval(req);

    if (decision.denied) {
      throw new AdcpError('GOVERNANCE_DENIED', {
        recovery: 'terminal',
        message: decision.reason,
      });
    }

    // Sync return → task transitions to `completed` with this as `result`
    return {
      media_buy_id: decision.media_buy_id,
      status: 'pending_creatives',
      confirmed_at: new Date().toISOString(),
    };
  },
};
```

**The buyer gets terminal state two ways:**

1. **Webhook push** — buyer included `push_notification_config: { url, token }` in the original request. Framework signs (RFC 9421) + delivers to that URL with the spec's `mcp-webhook-payload.json` envelope on terminal state. URL is validated server-side: rejects RFC 1918, loopback, link-local, CGNAT, IPv6 unique-local before delivery (SSRF guard).
2. **Polling** — buyer calls programmatic `server.getTaskState(taskId, accountId)` — same record. Native MCP `tasks/get` wire integration lands in v6.1; for now, adopter wraps `getTaskState` in their own `tasks/get` tool if needed.

**Always declare HITL when the surface is HITL-eligible.** Don't conditionally pick between sync and task variants based on the request — `validatePlatform()` rejects defining both anyway. If the fast path is the 99% case (pre-approved buyers, low-risk amounts), the `*Task` method resolves immediately and the buyer's first poll catches the terminal state. Uniform contract for the buyer; one code path for you. See § "HITL-sometimes" below.

**Sync-only tools that need long-running completion** use `publishStatusChange(...)` for lifecycle updates instead of HITL. The wire spec doesn't define `Submitted` arms for `update_media_buy`, `get_media_buy_delivery`, `build_creative` — long-running work for those publishes status changes (`media_buy` → `active` → `completed`) on the event bus and buyers subscribe.

## Per-creative review (partial-batch)

`syncCreatives` returns per-creative `status`. Mix freely:

```ts
syncCreatives: async (creatives, ctx) => {
  return creatives.map(c => ({
    creative_id: c.creative_id,
    status: this.requiresManualReview(c) ? 'pending_review' : 'approved',
    ...(c.violatesPolicy && { reason: c.violationReason }),
  }));
};
```

The wire spec carries `status` per row, so you don't need to wrap the whole batch in `ctx.runAsync`. For platforms whose ENTIRE batch goes through async manual review (Innovid, broadcast TV — 4-72h SLA), use `ctx.runAsync` around the whole call.

## HITL-sometimes (the "fast path through the slow door")

Many specialisms — broadcast TV, retail-media-with-traffic-review, governed-buy flows — are **HITL-by-default but fast-path-eligible**. Pre-approved buyers, low-risk amounts, or whitelisted SKUs sometimes resolve in milliseconds without paging a human.

The right answer is to **always declare the HITL variant** (`createMediaBuyTask`) and let it resolve immediately when no gate triggers. Don't conditionally pick between `createMediaBuy` and `createMediaBuyTask` — `validatePlatform()` rejects defining both, and the buyer experience should be uniform.

```ts
sales: SalesPlatform = {
  // Always-HITL declaration — buyer always sees `submitted` first.
  createMediaBuyTask: async (taskId, req, ctx) => {
    // Fast path: pre-approved buyer + low-risk amount → resolve before
    // the buyer's polling tick lands.
    if (this.isFastPathEligible(req, ctx.account)) {
      return this.commitImmediately(req); // resolves task in <10ms
    }
    // Slow path: trafficker review queue (hours-to-days). Returns when
    // the human acts.
    return await this.waitForTrafficker(taskId, req);
  },
  // ...
};
```

Why declare HITL even on the fast path: buyers receive `{ status: 'submitted', task_id }` on every call and either poll `tasks/get` or subscribe to status changes. That's a uniform contract — no branching on response shape, no "sometimes sync, sometimes async" surprises. The framework's task envelope handles immediate completion fine; the buyer gets the terminal artifact on its first poll.

If the fast path is the 99% case and HITL is rare, the right answer is still HITL-by-default — a sync `createMediaBuy` that occasionally throws `INVALID_STATE` to redirect buyers into a separate approval flow is worse UX than a uniform task envelope where most tasks complete in &lt;100ms.

## Buyer-driven approval as separate methods

Don't smush approval into `createMediaBuy` as a side-effect when the buyer can drive the workflow explicitly. AdCP has dedicated specialisms:

- `acquire_rights` — brand-rights specialism (`brand: BrandRightsPlatform`)
- `check_governance` — governance specialism (`governance: GovernancePlatform`, v1.1)
- `get_products` → `proposal_id` round-trips → `create_media_buy` commits

The buyer calls approval explicitly; `createMediaBuy` runs after the approval and is fast.

The escape hatch — `ctx.runAsync` + `ctx.startTask` — exists for the genuinely-opaque case where the buyer has no callable surface (GAM trafficker review where the operator's queue is internal).

## Error code vocabulary

`AdcpError`'s `code` field is `ErrorCode | (string & {})`. The 45 standard codes mirror `schemas/cache/3.0.0/enums/error-code.json`. Autocomplete works on the standard set; platform-specific codes are accepted (the `(string & {})` escape hatch).

Common codes:

- **Buyer-fixable** (`recovery: 'correctable'`): `INVALID_REQUEST`, `BUDGET_TOO_LOW`, `POLICY_VIOLATION`, `CREATIVE_REJECTED`, `MEDIA_BUY_NOT_FOUND`, `INVALID_STATE`, `REQUOTE_REQUIRED`
- **Transient** (`recovery: 'transient'`, retry with backoff): `RATE_LIMITED` (always include `retry_after`), `SERVICE_UNAVAILABLE`
- **Terminal** (`recovery: 'terminal'`, requires human action): `GOVERNANCE_DENIED`, `ACCOUNT_SUSPENDED`, `PERMISSION_DENIED`, `UNSUPPORTED_FEATURE`

Generic thrown errors (`Error`, `TypeError`) become `SERVICE_UNAVAILABLE` at the framework boundary.

## Account resolution

`accounts.resolve(ref)` is the single tenant boundary. Three resolution modes:

```ts
accounts: AccountStore<MyMeta> = {
  resolution: 'explicit', // default; buyer passes account_id inline
  // OR 'implicit': buyer must sync_accounts first; subsequent requests resolved from auth principal
  // OR 'derived': single-tenant; auth principal alone identifies the tenant

  resolve: async ref => {
    if ('account_id' in ref) return await this.db.findById(ref.account_id);
    return await this.db.findByBrand(ref.brand.domain, ref.operator);
    // Return null for unknown accounts; framework emits ACCOUNT_NOT_FOUND.
    // Or throw new AccountNotFoundError() if your codebase prefers throwing.
  },
  // ...
};
```

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

Cross-instance reads work — process A allocates the task, process B reads the lifecycle for `tasks/get`. Terminal-state idempotency is enforced via SQL `WHERE status = 'submitted'` so concurrent webhook deliveries can't race to overwrite each other. Background-completion tracking (`_registerBackground`) is process-local — promises don't serialize, so production HITL flows that span process boundaries drive completion via webhook → an explicit `complete()` / `fail()` from the receiving process.

Custom backend? Implement the `TaskRegistry` interface (8 methods) for Redis / DynamoDB / Spanner / etc. — the framework awaits each call so all 4 mutators (`create`, `complete`, `fail`, `getTask`) can be storage-backed.

## Observability hooks

Wire any telemetry backend (DataDog / Prometheus / OpenTelemetry / structured logger) via the framework's `observability` hooks:

```ts
const server = createAdcpServerFromPlatform(platform, {
  name: 'My Ad Network', version: '1.0.0',
  observability: {
    onAccountResolve: ({ tool, durationMs, resolved, fromAuth }) => {
      metrics.histogram('adcp.account_resolve.ms', durationMs, { tool, fromAuth });
    },
    onTaskCreate: ({ tool, taskId, accountId }) => {
      metrics.increment('adcp.task.created', { tool, accountId });
    },
    onTaskTransition: ({ tool, status, durationMs, errorCode }) => {
      metrics.histogram('adcp.task.duration_ms', durationMs, { tool, status, errorCode });
    },
    onWebhookEmit: ({ tool, status, success, durationMs }) => {
      metrics.increment('adcp.webhook.emit', { tool, status, success: String(success) });
    },
    onStatusChangePublish: ({ accountId, resourceType }) => {
      metrics.increment('adcp.status_change', { accountId, resourceType });
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
- Wire-level `tasks/get` round-trip for buyer polling (next commit)
- Webhook emitter on `notify` push (next commit)
- `ctx.runAsync` `maxAutoAwaitMs` cap with AbortSignal cancellation
- `getCapabilitiesFor(account)` per-tenant runtime
- Production safety gates (`NODE_ENV=production` requires durable task store)
