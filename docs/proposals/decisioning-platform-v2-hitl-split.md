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

#### Forward-compat: adopter code stays the same across 3.0 → 3.1

The adopter's code above works identically whether running against AdCP 3.0 (no status-change webhook in spec yet) or 3.1+ (status webhooks added). The framework adapts the wire projection based on the spec version:

| Spec version | What `syncAudiences` returns to the buyer | What `emitStatusChange` does |
|---|---|---|
| **3.0** (today) | Sync `SyncAudiencesSuccess` with per-row `status: 'matching'` | No subscription channel exists. Framework records the status change on its task registry; buyer polls `getAudienceStatus(audienceId)` to learn current state. |
| **3.1 with status-change webhooks** (proposed in this doc) | Same sync response | Framework emits signed webhook to subscribers of `audience_status_changes`. Buyer polling continues to work as a fallback. |
| **3.1 with sync-audiences-async-arm** (alternative spec proposal) | Framework converts the sync response into `SyncAudiencesSubmitted { task_id, ... }`; persists audiences as working tasks | Framework flips task to `completed` with the new status; pushes via `tasks/get` polling and `push_notification_config` webhook |

**The adopter writes one shape; framework picks the wire projection.** They don't have to know which spec version is active or whether the upstream proposals land. The same `syncAudiences` + `emitStatusChange` code works as the spec evolves; only the wire output shape changes underneath.

The mechanism: SDK reads `ADCP_VERSION` at construction (already present in the framework) and routes `emitStatusChange` calls through whichever delivery channel the active spec supports. If multiple are available, framework prefers webhook over polling — but adopter code doesn't see this.

This applies to all "slow with eventual ack" tools (`build_creative`, `sync_catalogs`, `activate_signal`, `getMediaBuyDelivery` for manual reports, `acquire_rights` when not HITL). The adopter writes Shape B once; framework projects to whatever the spec version supports.

Note: the HITL Shape A (`xxxTask`) doesn't have this forward-compat concern — `task_id` + `tasks/get` is already in spec since 3.0; the only delta would be the proposed `getMediaBuyDeliveryTask` arm, which is purely additive.

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

## Status-change subscriptions: extend MCP Resources, backport to A2A

Rather than inventing a fresh webhook taxonomy, AdCP picks up the **MCP Resources** model (already in protocol) and defines two things on top:

1. **Resource taxonomy**: AdCP's lifecycle resources expressed as MCP resources via a stable URI scheme — `adcp://{account_id}/{resource_type}/{resource_id}`. Resource types: `media_buy`, `creative`, `audience`, `signal`, `proposal`, `plan`, `rights_grant`, `delivery_report`.
2. **Per-resource status enums**: each resource type's allowed status transitions (already defined per-type elsewhere in the spec).

### MCP transport (native, free for subscription-capable clients)

```
resources/list                          → enumerate resources for the authenticated account
resources/read?uri=adcp://...           → current state (status + payload) of one resource
resources/subscribe?uri=adcp://...      → subscribe to a single resource OR a pattern
resources/unsubscribe                   → drop subscription
notifications/resources/updated         → server pushes when status / payload changes
```

URI patterns: `adcp://acc_1/media_buy/mb_42` (single), `adcp://acc_1/media_buy/*` (all of one type), `adcp://acc_1/*` (everything for the account).

Wire envelope on `notifications/resources/updated` follows MCP's spec (resource URI + new contents). The contents body carries:

```json
{
  "resource_type": "media_buy",
  "resource_id": "mb_42",
  "previous_status": "pending_creatives",
  "new_status": "pending_start",
  "changed_at": "2026-04-25T12:34:56Z",
  "snapshot": { /* full current resource state */ },
  "details": { /* resource-type-specific extras (e.g., match_rate for audiences) */ }
}
```

### A2A transport (backport — AdCP defines as part of the AdCP-over-A2A spec)

A2A doesn't have a native resource-subscription concept. AdCP backports the same surface as four DataPart-typed message contracts:

```
{ kind: 'data', data: { adcp_action: 'resources/list' } }
  → response: { resources: [...] }

{ kind: 'data', data: { adcp_action: 'resources/read', uri: 'adcp://...' } }
  → response: current resource state

{ kind: 'data', data: { adcp_action: 'resources/subscribe', uri: 'adcp://...', push_url: 'https://buyer.example.com/webhook' } }
  → response: { subscription_id }
  → subsequent: signed RFC 9421 webhooks pushed to push_url

{ kind: 'data', data: { adcp_action: 'resources/unsubscribe', subscription_id } }
```

A2A push uses the buyer's `push_notification_config.url` machinery (already in spec). Status changes are signed and PUT to that URL. The body shape is identical to MCP's `notifications/resources/updated` content — same parser on both transports.

Positive externality: this contributes the resource-subscription pattern to the A2A ecosystem more broadly. Useful well beyond ad tech.

### Client-compat: graceful degradation for clients without subscription support

Most MCP clients today don't implement `resources/subscribe` (Claude Code partial; ChatGPT none; Copilot/Cursor/Cline varying). AdCP doesn't require it — clients that can't subscribe fall back to polling:

| Client | Subscribe support | Buyer pattern |
|---|---|---|
| Subscription-capable | yes | `resources/subscribe` once; receive pushes |
| Polling-only | no | Periodic `resources/read` on the URIs they care about |
| Buyer using A2A | yes (via webhook config) | `resources/subscribe` with push_url |

The framework's `server.emitStatusChange(...)` adapter doesn't know which buyer is on which client mode. It records the new resource state in its registry. Subscribers get a push; polling clients see the new state on their next `resources/read`. No adopter code changes; no buyer-side branching beyond "do I want to subscribe or poll?"

For existing AdCP 3.0 clients (no resources at all): framework projects status changes to `tasks/get` continuation as a 3.0-compatible fallback (the `*-async-response-working.json` arm carries intermediate state). This is the forward-compat path that lets buyers on 3.0 clients see lifecycle changes too, just less efficiently.

### Why this framing is better than inventing webhook channels

- **Smaller upstream proposal**: "extend MCP Resources for AdCP" is much smaller than "add 7 new webhook channel types"
- **Native subscription mechanism**: clients that already subscribe to MCP resources get AdCP status changes for free as `resources/subscribe` adoption grows
- **AdCP contributes A2A backport**: defining resource-subscriptions for A2A benefits the broader agentic ecosystem
- **Single envelope across transports**: same content body on MCP `notifications/resources/updated` and A2A push webhook — buyer parser is one path
- **Forward-compat to 3.0 clients**: degrades to polling or `tasks/get` continuation; no flag day

Status: spec proposal. The MCP Resources extension and A2A backport go in as a **3.1 feature**.

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

### Issue 1: Resource-subscription model — adopt MCP Resources, backport to A2A

Define lifecycle resources in AdCP via the URI scheme `adcp://{account_id}/{resource_type}/{resource_id}` covering 8 resource types (`media_buy`, `creative`, `audience`, `signal`, `proposal`, `plan`, `rights_grant`, `delivery_report`). MCP transport uses native `resources/list` / `resources/read` / `resources/subscribe` / `notifications/resources/updated`. A2A transport gets a backport: AdCP defines `resources/list` / `resources/read` / `resources/subscribe` / `resources/unsubscribe` as DataPart-typed message contracts, with status changes pushed via the buyer's `push_notification_config.url`. Same content envelope on both transports.

Single-page proposal benefits: no new webhook channels invented (just a resource taxonomy on top of an existing protocol), client improvements flow automatically, A2A ecosystem benefits from the backport.

### Issue 2: Extend async-response pattern to remaining tools

Add `*-async-response-{input-required, submitted, working}` schemas for:

- `acquire_rights` — legal review takes days; clear HITL case
- `getMediaBuyDelivery` — manual report runs (alternative: rely on resource-subscription with `delivery_report` resource type from Issue 1)
- `sync_audiences`, `activate_signal` — likely better served by resource-subscription rather than async response triplet

The two issues are interdependent: if Issue 1 lands cleanly, Issue 2 narrows to just `acquire_rights` (the only tool that's HITL-by-nature with no obvious resource-subscription analog).

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

3. **Resource subscriptions before spec lands**: ship the SDK with `server.emitStatusChange` API + the resource taxonomy + URI scheme. Adopter code is stable across spec evolution (per the forward-compat section). Subscription-capable MCP clients (Claude Code partial, A2A buyers via push_url) get pushes immediately. Polling-only clients (ChatGPT, others) fall back to `resources/read`. Existing 3.0 clients (no resources at all) fall back to `tasks/get` continuation.

4. **`getMediaBuyDelivery` async support**: handle via the resource-subscription model (Issue 1) — `delivery_report` becomes a resource type. Buyer subscribes to `adcp://acc/delivery_report/*`; framework pushes when reports are ready. Cleaner than adding a `getMediaBuyDeliveryTask` arm to the spec.

5. **A2A push_url discoverability**: A2A's resource-subscription backport requires the buyer to register a webhook URL on the `resources/subscribe` call. AdCP needs to spec the per-call vs per-session push-config semantics — does each subscribe call carry its own push_url, or do they share the agent-level `push_notification_config` registered at session start? Lean toward per-subscribe-call (more flexible; buyer can route different resource types to different webhooks).

6. **MCP client adoption gap**: Claude Code, ChatGPT, Cursor, Cline, Copilot — none of them fully implement `resources/subscribe` today. SDK ships with the polling-fallback path on `resources/read`; subscription is the optimization, not a hard requirement. Worth tracking client-by-client which support-level they're at and documenting in the build-decisioning-platform skill.

## Multi-tenant dispatch — Salesagent feedback

The biggest architectural concern from the Prebid salesagent team: their deployment serves many tenants, where the same tool can be HITL for one tenant (broadcast-TV) and sync for another (programmatic). The "pick one shape per tool" model assumes per-platform-class choice — works for single-tenant client SDKs, awkward for multi-tenant servers.

Their current pattern: a sync method that throws `ManualApprovalRequired` to switch to HITL dynamically. Equivalent to v1's `ctx.runAsync` conditional shape — which we explicitly killed for buyer-predictability reasons. So we have a real tension.

**Resolution: per-tenant platform routing.** The `DecisioningPlatform` interface gets an optional per-account selector that returns the right specialism shape based on the resolved tenant:

```ts
class MyMultiTenantAgent implements DecisioningPlatform {
  capabilities = {...}
  accounts = {...}

  // Optional: route to per-tenant specialism impls. When present, framework
  // calls this AFTER accounts.resolve() and dispatches the request to the
  // returned platform's tool method. When absent, framework uses the static
  // `sales` / `creative` / `audiences` declarations.
  getSpecialism?: <K extends keyof SpecialismMap>(specialism: K, account: Account) => SpecialismMap[K];

  // Per-tenant impls — adopter holds these, returns the right one:
  private broadcastTvSales: SalesPlatformHitl = {
    createMediaBuyTask: async (taskId, req, ctx) => {
      // Trafficker review pipeline
    },
  };
  private programmaticSales: SalesPlatformSync = {
    createMediaBuy: async (req, ctx) => {
      // Sync programmatic
    },
  };
}
```

The buyer-predictability argument still holds: a buyer reaching tenant A always sees HITL on `create_media_buy`; a buyer on tenant B always sees sync. The shape is stable per-tenant, just not per-platform-class. Documented in `getCapabilitiesFor(account)` (already in v1.0 alpha) — a buyer querying `get_adcp_capabilities` for their account learns which shape applies.

For salesagent specifically: their existing `ManualApprovalRequired` throw-pattern wraps one tool method that conditionally goes HITL. Under the new shape, that conditional dispatch moves to `getSpecialism()` — same code path, just lifted out of the tool method into the framework's dispatch layer. Slight refactor but no semantic change.

## Python port — sum-type alternative

The TS surface uses 7 tools × 2 method-name variants = 14 declared methods. In Python this is heavier:

- TS's `RequiredPlatformsFor<'sales-broadcast-tv'>` compile-time gate doesn't translate; Python falls back to runtime `validate_platform()` from day one.
- 14 protocol methods on a `Protocol` class is more boilerplate than feels native in Python.

Salesagent's counter-proposal: **single `_impl` method per tool, returning a sum type**:

```python
@dataclass
class SyncResult(Generic[T]):
    value: T

@dataclass
class TaskAccepted(Generic[T]):
    work: Callable[[], Awaitable[T]]
    message: str | None = None

# Adopter writes ONE method per tool:
async def create_media_buy(
    self, req: CreateMediaBuyRequest, ctx: RequestContext
) -> SyncResult[MediaBuy] | TaskAccepted[MediaBuy]:
    if req.tenant.is_broadcast_tv:
        return TaskAccepted(work=lambda: self.queue_for_trafficker(req))
    return SyncResult(value=self.platform.create(req))
```

Framework dispatches based on which sum-type variant the method returns. Adopter writes one signature, gets the same wire result.

**Trade-off**: the sum-type approach loses "shape is stable per-tenant" at the type level — TypeScript's per-tenant `SalesPlatformHitl | SalesPlatformSync` could in principle be enforced by `getSpecialism`'s return type, while a single Python method that conditionally returns either variant doesn't expose tenant routing to the type checker. Buyer-predictability becomes a runtime contract documented in the skill, not a type-level guarantee.

**Recommendation for Python port**: ship the sum-type shape. The compile-time enforcement was already weak in Python; adding 14 method names per specialism doesn't earn its weight. Document buyer-predictability via convention (the same tenant always returns the same sum-type variant) rather than enforce it via types.

The TS port keeps the two-method shape because the compile-time gate IS valuable there — `RequiredPlatformsFor<'sales-broadcast-tv'>` catches the wrong shape at build time. Different language, different best ergonomics.

## Event-bus emission instead of `server.emitStatusChange(...)`

Salesagent observation: `server.emitStatusChange(...)` requires the adopter to hold a reference to the server instance. In Python/Flask multi-tenant deployments this becomes thread-local or singleton — both invite circular imports and complicate testing.

**Cleaner shape: framework-provided event bus**:

```python
# Adopter imports the bus, doesn't need server reference:
from adcp.events import publish, StatusChange

async def my_match_pipeline(audience_id):
    matched = await run_match(audience_id)
    publish(StatusChange(
        account_id=...,
        resource_type='audience',
        resource_id=audience_id,
        new_status='active' if matched else 'failed',
    ))
```

The framework subscribes to the bus at server startup; emits to wire (MCP `notifications/resources/updated` or A2A push_url) on each event. Decouples adopter from server instance entirely.

**For TS**: same idea works. `import { publishStatusChange } from '@adcp/client/server/decisioning';` — module-level event registry instead of a method on the server handle. Cleaner for the multi-tenant case since the same publish call works regardless of which tenant the calling code is running for.

Adopting the event-bus shape across both ports.

## Other concerns

**Resource URI privacy**: `adcp://acc_1/media_buy/mb_42` exposes `account_id` in MCP resource lists, error logs, client-side caches. Account ID is already authenticated to the buyer that's reading it (own-tenant), but ops-staff log aggregation could leak across operator/buyer trust boundaries. Recommendation: spec the URI's `account_id` segment as a tenant-private identifier; SDK's logging surface masks it; documented contract on what's safe to surface client-side. Add to the upstream proposal.

**3.0 fallback retention bound**: 3.0 clients see status changes via `tasks/get` continuation. The framework's task registry retains every status transition until the buyer polls or some retention bound. Without a bound, slow leak under buyers that subscribe but never poll. Spec the retention (recommend 7 days post-terminal), document GC behavior. Add to the upstream proposal.

**Naming `xxxTask`**: salesagent flagged that "task" is overloaded in their codebase (deprecated `tasks` table + active `workflow_steps`). For TS port, `xxxTask` matches the wire (`task_id`, `tasks/get`); for Python port using the sum-type shape, naming dodges entirely — the discriminator is the return type, not the method name. Different ports, different naming surfaces; the wire name (`task_id`) is the common ground.

**`acquire_rights` / `update_media_buy` "HITL sometimes"**: legitimate edge case. Resolution: declare HITL always; complete the task immediately when no approval is needed. Buyer always sees submitted envelope but the task completes instantly on `tasks/get` first poll. Slight buyer-side regression for no-approval-needed case; clean alternative is per-tenant routing (above). Document the trade-off in the skill.



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
