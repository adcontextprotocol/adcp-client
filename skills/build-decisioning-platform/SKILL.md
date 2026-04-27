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

  sales: SalesPlatform = {
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

1. Methods return `Promise<T>` directly. No `ok()` / `submitted()` / `rejected()` wrappers.
2. `throw new AdcpError(code, opts)` for buyer-facing structured rejection.
3. For in-process async opt-in: `await ctx.runAsync(opts, fn)`.

## Four async patterns

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

### 3. In-process async — `ctx.runAsync`

When the work might exceed the framework's auto-defer timeout (default 30s):

```ts
createMediaBuy: async (req, ctx) => {
  if (this.requiresOperatorReview(req)) {
    return await ctx.runAsync(
      {
        message: 'Awaiting operator approval',
        partialResult: this.toPendingBuy(req),
      },
      async () => {
        return await this.waitForOperatorApproval(req); // resolves to MediaBuy
      }
    );
  }
  return await this.platform.create(req);
};
```

What happens:

- `fn()` resolves before `submittedAfterMs` → returns the value normally (sync wire arm).
- `fn()` exceeds `submittedAfterMs` → throws `TaskDeferredError`; runtime catches, projects to submitted wire envelope with `task_id`, `message`, `partial_result`. Meanwhile `fn()` keeps running in the background; on resolve, framework calls `notify({ kind: 'completed', result })`. On throw — `AdcpError` projects to structured rejection on the registry record; generic `Error` becomes `SERVICE_UNAVAILABLE`.

Adopters never see `TaskDeferredError`; the runtime hides it. From your code's perspective, you just `await ctx.runAsync(...)` and get back a value.

### 4. Out-of-process async — `ctx.startTask`

When completion arrives in a different request lifecycle (operator webhook hours later):

```ts
createMediaBuy: async (req, ctx) => {
  if (this.requiresOperatorReview(req)) {
    const handle = ctx.startTask<MediaBuy>({ partialResult: this.toPendingBuy(req) });
    await this.queueForReview({ taskId: handle.taskId, request: req });
    // The webhook handler later calls `handle.notify({ kind: 'completed', result })`
    // — typically by reading the persisted taskId and looking up the handle
    // (or via `server.completeTask(taskId, result)` once the v6 wire path lands).

    // ctx.startTask alone doesn't signal "I'm async" to the framework;
    // wrap in ctx.runAsync if you also want auto-defer race semantics:
    return await ctx.runAsync({ message: 'Pending operator review', partialResult: this.toPendingBuy(req) }, () =>
      this.waitForExternalNotify(handle.taskId)
    );
  }
  return await this.platform.create(req);
};
```

For most adopters: prefer `ctx.runAsync`. Use `ctx.startTask` only when you can't await the completion in-process at all (e.g., your webhook handler runs on a different process/region from the original request).

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
