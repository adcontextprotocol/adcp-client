# DecisioningPlatform v2 — HITL task split + status-change webhooks

> **Status: design proposal.** Not implemented. v1.0 alpha (`createAdcpServerFromPlatform` + `ctx.runAsync` + `ctx.startTask`) remains the current SDK shape. This proposal supersedes v1.0's `ctx.runAsync` pattern with a cleaner HITL-vs-slow split. Adopter feedback on this doc gates the implementation.

## Why a v2

The v1.0 alpha conflates two distinct workflows under one `ctx.runAsync` primitive:

1. **HITL** ("human-in-the-loop"): the seller cannot acknowledge the buyer's request at all until a human acts (broadcast TV trafficker, IO signing, custom proposal generation). No `media_buy_id` exists yet; the buyer can only see a task envelope.
2. **Slow with eventual ack** (LiveRamp identity match, signal activation, generative creative): the seller acknowledges the request immediately with a resource ID, then the resource transitions through states asynchronously. The buyer wants to know about state changes, not wait for them.

`ctx.runAsync` tries to handle both via a timeout race, which has three problems:

- **Mixed mental model**: adopters can't tell from the type system whether their tool is HITL-or-fast vs slow-but-acknowledged. The race-against-timeout makes it conditional per-request.
- **Buyer-side unpredictability**: same buyer, same call, sometimes gets sync, sometimes submitted. Bad for caching, retries, observability.
- **Non-spec `partial_result` field**: the v1.0 projection emits `partial_result` on the wire's submitted envelope, but AdCP 3.0 doesn't define this field on `CreateMediaBuySubmitted` / `SyncCreativesSubmitted`. Buyers reading the wire can't rely on it.

## Two workflow shapes, declared per tool

### Shape A — HITL: `*Task` method variants

For tools where the seller cannot answer "did it work" until a human acts:

```ts
sales: SalesPlatform = {
  // HITL variant — adopter implements this when the workflow blocks on human approval
  createMediaBuyTask: async (taskId, req, ctx) => {
    // Framework has already created the task and returned a submitted envelope to the buyer.
    // Platform reserves inventory, runs internal checks, queries trafficker.
    // Returns the MediaBuy when accepted, or throws AdcpError on rejection.
    const reservation = await this.reserveInventory(req);
    const traffickerDecision = await this.queueTraffickerReview(reservation);
    if (traffickerDecision.rejected) {
      throw new AdcpError('TERMS_REJECTED', {
        recovery: 'correctable',
        message: traffickerDecision.reason,
      });
    }
    return { media_buy_id: reservation.id, status: 'pending_creatives', ... };
  },
};
```

Wire flow:

1. Buyer calls `create_media_buy` over MCP/A2A
2. Framework receives request, runs auth + idempotency + capability gates
3. Framework checks whether `createMediaBuy` (sync) or `createMediaBuyTask` (HITL) is defined
4. HITL path: framework creates a task in the registry, returns `CreateMediaBuySubmitted { task_id, message }` to the buyer **immediately** (response complete)
5. Framework schedules `createMediaBuyTask(taskId, req, ctx)` to run in background
6. When `createMediaBuyTask` returns: framework records the result on the task. Buyer sees the resolved `MediaBuy` on the next `tasks/get` poll.
7. When `createMediaBuyTask` throws `AdcpError`: framework records the failure. Buyer sees the structured error envelope on `tasks/get`.
8. `media_buy_status_changes` webhook fires when subsequent state transitions happen (post-acceptance lifecycle).

Adopter never touches a task handle. They write a function that "does the work."

### Shape B — Slow with sync ack: status-change webhooks

For tools where the seller can acknowledge immediately but ongoing state takes time:

```ts
audiences: AudiencePlatform = {
  // Sync method returns immediately with audience_id + initial status
  syncAudiences: async (audiences, ctx) => {
    // Accept the request, persist with status: 'matching', return immediately
    const ids = await this.persist(audiences);
    // Kick off the slow match in background — fire-and-forget
    this.runMatchPipeline(ids).catch(err => this.logError(err));
    return ids.map(id => ({ audience_id: id, status: 'matching' }));
  },
  getAudienceStatus: async (audienceId, ctx) => this.lookupStatus(audienceId),
};

// Elsewhere, when matching completes:
class MyPlatform {
  constructor(private server: DecisioningAdcpServer) {}

  private async runMatchPipeline(audienceIds: string[]) {
    for (const id of audienceIds) {
      const matched = await this.runMatch(id);
      // Framework formats + signs + sends the webhook to all subscribers
      await this.server.emitStatusChange({
        account_id: this.accountIdFor(id),
        resource_type: 'audience',
        resource_id: id,
        new_status: matched.success ? 'active' : 'failed',
        details: { match_rate: matched.rate },
      });
    }
  }
}
```

Wire flow:

1. Buyer calls `sync_audiences` over MCP/A2A
2. Framework dispatches to `audiences.syncAudiences`
3. Platform persists, kicks off background match, returns immediately with per-audience initial status
4. Buyer receives `SyncAudiencesSuccess { audiences: [{ audience_id, status: 'matching' }] }` synchronously
5. Background match completes; platform calls `server.emitStatusChange(...)`
6. Framework signs (RFC 9421) and pushes webhook to buyers subscribed to `audience_status_changes` for this account
7. Buyer receives `AudienceStatusChangeNotification { audience_id, new_status: 'active', ... }` and updates its model

The buyer doesn't poll. The status is pushed.

## Categorization of all spec-async-eligible tools

| Tool | v1.0 alpha (current) | v2 proposed | Rationale |
|---|---|---|---|
| `get_products` | sync OR `ctx.runAsync` | `getProducts` (sync) OR `getProductsTask` (HITL) | Custom proposal systems are HITL (sales team manually generates pitch); programmatic lookups are sync. |
| `create_media_buy` | sync OR `ctx.runAsync` | `createMediaBuy` (sync) OR `createMediaBuyTask` (HITL) | Broadcast TV / guaranteed-inventory: HITL. Programmatic: sync, with `media_buy_status_changes` for post-creation lifecycle. |
| `update_media_buy` | sync only (no spec submitted arm) | `updateMediaBuy` (sync) OR `updateMediaBuyTask` (HITL) | Re-approval edge case: HITL. Most patches: sync, with status-change webhook for downstream effects. |
| `sync_creatives` | sync OR `ctx.runAsync` | `syncCreatives` (sync) OR `syncCreativesTask` (HITL) | Mandatory pre-persist review: HITL. Standard intake: sync with per-row status, `creative_status_changes` for ongoing review state. |
| `build_creative` | n/a in v1 | `buildCreative` (sync) — slow compute, status via webhook | Generative pipelines are slow but not HITL; ack with `creative_id` + `status: 'building'`, fire `creative_status_changes` when done. |
| `sync_catalogs` | n/a in v1 | `syncCatalogs` (sync) — slow ingest, status via webhook | Catalog ingestion, no human review; ack + status webhook. |
| `get_media_buy_delivery` | sync only | `getMediaBuyDelivery` (sync) — async via `delivery_status_changes` webhook | Manual report runs: ack with `report_id` + `status: 'running'`, push when ready. **Not yet in spec — propose upstream.** |
| `sync_audiences` | sync only | `syncAudiences` (sync) — `audience_status_changes` webhook | LiveRamp identity-match. **Not yet async in spec — propose upstream.** |
| `activate_signal` | sync only | `activateSignal` (sync) — `signal_status_changes` webhook | Destination activation. **Not yet async in spec — propose upstream.** |
| `acquire_rights` | sync only | `acquireRights` (sync) OR `acquireRightsTask` (HITL) | Legal review can take days (HITL); routine licensing is sync with `rights_status_changes` webhook. |

## Status-change webhook channels (proposed)

Five new webhook channels, one per lifecycle resource type:

- `media_buy_status_changes` — pending_creatives → pending_start → active → paused → completed → canceled
- `creative_status_changes` — pending_review → approved/rejected; building → ready/failed
- `proposal_status_changes` — issued → committed → expired
- `audience_status_changes` — pending → matching → matched → activating → active → archived → failed
- `signal_status_changes` — pending → activating → active → failed
- `delivery_status_changes` — running → ready → updated → final
- `rights_status_changes` — pending → granted/denied → revoked

Subscription model: each webhook channel is independently subscribable per buyer per account, just like `delivery_reporting` works today. Buyer registers `push_notification_config.url` once; framework signs each emission with RFC 9421.

Wire envelope (all status-change webhooks share this shape):

```json
{
  "resource_type": "media_buy",
  "resource_id": "mb_42",
  "account": { "account_id": "acc_1" },
  "previous_status": "pending_creatives",
  "new_status": "pending_start",
  "changed_at": "2026-04-25T12:34:56Z",
  "details": { /* resource-specific extras */ }
}
```

This is a spec proposal — does not exist in AdCP 3.0 today. Status-change webhooks would be a **3.1 feature**.

## SDK API surface (post-refactor)

```ts
import {
  AdcpError,
  createAdcpServerFromPlatform,
  type DecisioningPlatform,
  type SalesPlatform,
  type DecisioningAdcpServer,
} from '@adcp/client/server/decisioning';

// Adopter writes ONE class:
class MyAdNetwork implements DecisioningPlatform {
  // ... capabilities, accounts, statusMappers ...

  sales: SalesPlatform = {
    // Pick exactly ONE of each pair (compile-time enforced via RequiredPlatformsFor):
    getProducts: async (req, ctx) => /* sync */,
    // OR getProductsTask: async (taskId, req, ctx) => /* HITL */,

    createMediaBuy: async (req, ctx) => /* sync, returns MediaBuy */,
    // OR createMediaBuyTask: async (taskId, req, ctx) => /* HITL */,

    syncCreatives: async (creatives, ctx) => /* sync per-creative status */,
    // OR syncCreativesTask: async (taskId, creatives, ctx) => /* HITL */,

    updateMediaBuy: async (buyId, patch, ctx) => /* sync */,
    // OR updateMediaBuyTask: async (taskId, buyId, patch, ctx) => /* HITL */,

    getMediaBuyDelivery: async (filter, ctx) => /* sync only at wire level today */,
  };
}

const server: DecisioningAdcpServer = createAdcpServerFromPlatform(new MyAdNetwork(), {
  name: 'My Ad Network',
  version: '1.0.0',
  // ... existing options
});

// Status-change webhooks: emit from anywhere in the platform's code:
await server.emitStatusChange({
  account_id: 'acc_1',
  resource_type: 'media_buy',
  resource_id: 'mb_42',
  new_status: 'active',
});
```

### `RequestContext` shape

Drops `runAsync` and `startTask`. The new `ctx`:

```ts
interface RequestContext<TAccount = Account> {
  account: TAccount;
  state: WorkflowStateReader;     // unchanged
  resolve: ResourceResolver;       // unchanged
  // No runAsync, no startTask. The HITL variant receives `taskId` directly.
}
```

### `RequiredPlatformsFor<S>` — compile-time HITL enforcement

Per-specialism, the type forces the right method shape:

```ts
RequiredPlatformsFor<'sales-non-guaranteed'>
  = { sales: SalesPlatformAny }   // either sync or task per-tool

RequiredPlatformsFor<'sales-guaranteed'>
  = { sales: SalesPlatformHitl }  // forces *Task variants on create/update

RequiredPlatformsFor<'sales-broadcast-tv'>
  = { sales: SalesPlatformHitl }  // ditto

RequiredPlatformsFor<'sales-social'>
  = { sales: SalesPlatformSync }  // forces sync variants — programmatic by definition
```

Where `SalesPlatformAny` is the discriminated union of `SalesPlatformSync | SalesPlatformHitl` plus per-tool flexibility. Implementation detail; surfaces clean compile errors when adopter mixes wrong.

## Task-creation fingerprint dedup

For HITL tools (`*Task` methods), the framework dedups by request fingerprint:

```ts
fingerprint = sha256(account_id || tool_name || canonical_json(request_body))

// In the task creation path:
const existing = registry.findActiveByFingerprint(fingerprint);
if (existing && !isTerminal(existing.status)) {
  return existing.task_id;  // buyer retry returns the same task — no duplicate work
}
const task = registry.createTask({ ..., fingerprint });
```

Three properties:
- Buyer retries a slow `getProductsTask` → same `task_id`, no duplicate proposal generation.
- Idempotency-key middleware still runs at the wire layer for mutating tools; this dedup is at the task-creation layer, orthogonal.
- Per-tenant scoping via `account_id` — different buyers get different tasks even on identical bodies.

## Migration from v1.0 alpha

Existing v1 alpha adopters (none in production yet — the alpha is preview-only) migrate by:

1. **Drop `ctx.runAsync` calls**. Either:
   - Move to sync method: return the value directly. Add status-change webhook emission for ongoing lifecycle.
   - Move to HITL: rename method to `xxxTask`, add `taskId` first param.
2. **Drop `ctx.startTask` calls**. Same options as above.
3. **Drop `partialResult`**. Spec doesn't carry it; status-change webhooks subsume the use case.

The MockSeller worked example will be rewritten to demonstrate both patterns end-to-end.

## Upstream spec proposals (parallel work)

Two issues to file against `adcontextprotocol/adcp`:

### Issue 1: Status-change webhook channels

Add five new webhook channel types: `media_buy_status_changes`, `creative_status_changes`, `proposal_status_changes`, `audience_status_changes`, `signal_status_changes`, `delivery_status_changes`, `rights_status_changes`. Common envelope shape (above). RFC 9421 signed. Subscription via existing `push_notification_config` with new `event_types` field.

### Issue 2: Extend async-response pattern to remaining tools

Add `*-async-response-{input-required, submitted, working}` schemas for:
- `get_media_buy_delivery` (manual report runs)
- `sync_audiences` (identity-graph match — though this might be better served by status webhook only)
- `activate_signal` (destination activation — same)
- `acquire_rights` (legal review takes days — HITL)

Possibly: roll these into the status-webhook shape rather than expanding the async-response triplet — depends on which feels cleaner to the spec maintainers.

## Implementation phases

If approved, the implementation is roughly:

1. **Phase 1**: SDK refactor — drop `ctx.runAsync` / `ctx.startTask` / `partial_result`; introduce `xxxTask` method shape per spec-HITL-eligible tool; runtime dispatch decides sync vs task based on which method is defined; per-specialism compile-time enforcement.
2. **Phase 2**: Task-creation fingerprint dedup.
3. **Phase 3**: `server.emitStatusChange` runtime wired through to existing webhook emitter; per-buyer subscription tracking.
4. **Phase 4**: MockSeller worked example rewrite + skill rewrite + migration sketch update.
5. **Phase 5**: Upstream spec proposals filed in parallel.

Estimated 3-5 commits, ~half-day to a day of focused work depending on how cleanly Phase 1 lands.

## Open questions

1. **Naming**: `xxxTask` (matches wire `task_id`) vs `xxxHitl` (matches workflow nature) vs `xxxAsync` (most common in async ecosystems). I lean `Task` because (a) it pairs with `tasks/get` wire surface, (b) "async" is overloaded in JS where every method is async-by-default.

2. **Compile-time exactly-one enforcement**: TypeScript can express "either A or B, not both" via discriminated unions, but the syntax for declaring a method-pair-where-exactly-one-is-defined is awkward. Pragmatic answer: type-level allows both, runtime `validatePlatform` throws if both defined or neither. Documented invariant + clear error.

3. **Status-change webhooks before spec lands**: ship the SDK with `server.emitStatusChange` API, project to `ext.status_change` until the spec adds it as a first-class field, OR wait for spec consensus before shipping. Lean toward shipping — adopters who want this can put their buyers behind ext-aware client; spec catches up.

4. **`getMediaBuyDelivery` async support**: spec doesn't currently model it. Two options: (a) ship sync-only with status webhooks for the slow case, (b) propose upstream `getMediaBuyDeliveryTask` arm. Lean toward (a) — webhooks fit the data-streaming nature better than tasks.

## What this gives up

- **Per-request flexibility**: a tool can no longer be sync-sometimes / task-other-times. The adopter picks one shape per tool. This is a feature, not a bug — buyer mental model becomes consistent.

- **Inline async opt-in convenience**: `await ctx.runAsync(opts, fn)` was 1 line; the new HITL pattern is a separate method. More code, but each method is single-purpose.

- **`partialResult` on the submitted envelope**: dropped because it's not in spec. Buyers who need to see partial state during HITL workflows poll `tasks/get`, which can carry intermediate state on the task's working artifact (this IS in the spec — `*-async-response-working.json`).

## What this enables

- **Tasks become first-class**: query "what's open for tenant X", historical durations, restart-resume, monitoring dashboards.
- **Status-change webhooks**: lifecycle events have a uniform subscription pattern across all resource types. Buyers don't need to track per-resource task IDs.
- **Stronger compile-time safety**: per-specialism, the right method shape is required. `sales-broadcast-tv` adopter can't accidentally implement sync `createMediaBuy` and silently regress trafficker workflow.
- **Cleaner DX**: each method is single-purpose. No timeout race to debug. No `partialResult` to forget. No "did this go async this time?" surprises.

## Sign-off needed

This proposal is design-only. Implementation gates on:

1. Naming (`xxxTask` confirmed vs alternative)
2. Status-change webhook spec proposal (file upstream now or wait for spec)
3. Phase ordering acceptable
4. No major design objections from adopter teams (Prebid + Scope3) on the new shape
