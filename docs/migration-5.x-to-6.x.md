# Migrating from `@adcp/client` 5.x to 6.0 (preview)

> **Status: Preview.** v6.0 ships behind `@adcp/client/server/decisioning`.
> The legacy v5.x handler-style API (`createAdcpServer({ mediaBuy: { ... } })`)
> remains the production path until v6.0 GA. The `mergeSeam` mode lets you
> migrate one specialism at a time without rewriting your whole agent.

## Why migrate?

v6.0 collapses the v5 handler-bag (per-domain `mediaBuy` / `creative` /
`accounts` / `signals` / `governance` / `eventTracking` / `brandRights` /
`sponsoredIntelligence` blocks) into one `DecisioningPlatform` class
organized by specialism. The framework owns wire mapping, account
resolution, idempotency, signing, async tasks, status normalization, and
lifecycle state. You write the business decisions.

Concrete wins:

- **Compile-time specialism enforcement** via `RequiredPlatformsFor<S>`
  — claim `'sales-non-guaranteed'` and the typechecker requires you to
  provide `sales: SalesPlatform`.
- **Framework-owned response envelopes** — return wire success arms;
  `throw AdcpError(code, opts)` for structured rejection. No more
  `wrapEnvelope` / `serviceUnavailable` / `versionUnsupported` plumbing.
- **HITL split** — `createMediaBuyTask(req, ctx)` returns the terminal
  artifact; framework returns the submitted envelope to the buyer
  immediately and runs your method in the background.
- **`tasks_get` auto-registered** — buyers poll HITL task lifecycle
  without you writing the polling tool.
- **`publishStatusChange(...)` event bus** replaces ad-hoc webhook
  emission; framework projects to MCP Resources subscribers.
- **Observability hooks** — `onAccountResolve`, `onTaskCreate`,
  `onTaskTransition`, `onWebhookEmit`, `onStatusChangePublish` plug
  directly into your existing logger/metrics adapter.
- **Postgres-backed `TaskRegistry`** for durable HITL across processes.

## The merge seam — incremental migration

`createAdcpServerFromPlatform(platform, opts)` accepts the v5 handler-style
domains as `opts` alongside the v6 platform interface. **Platform-derived
handlers WIN per-key**; adopter handlers fill gaps for tools the v6
platform doesn't yet model. Migrate one specialism at a time.

```ts
import { createAdcpServerFromPlatform } from '@adcp/client/server/decisioning';

createAdcpServerFromPlatform(myPlatform, {
  name: 'My Ad Network', version: '1.0.0',
  mergeSeam: 'strict',  // CI default — fail on collisions

  // v5 leftover handlers — keep until you migrate each specialism
  brandRights: {
    get_brand_identity: handleGetBrandIdentity,
    get_rights: handleGetRights,
    acquire_rights: handleAcquireRights,
  },
  customTools: {
    update_rights: { /* schema + handler */ },
    creative_approval: { /* schema + handler */ },
  },
});
```

Pick a `mergeSeam` mode based on your environment:

| Mode | When to pick |
| --- | --- |
| `'warn'` (default) | Local dev, mid-migration. Logs every collision at construction. |
| `'log-once'` | Multi-tenant host running N constructions per process / hot-reload dev. |
| `'strict'` | CI / new deployments. Throws `PlatformConfigError` on collision. |
| `'silent'` | Intentional override — you've audited the collision. |

## Step-by-step migration

### 1. Identify your specialisms

In v5, you declared `specialisms: []` (or whatever) in `get_adcp_capabilities`.
In v6, the typechecker enforces the claim. Map your existing handlers to
v6 specialisms:

| v5 handler block | v6 specialism | Platform interface field |
| --- | --- | --- |
| `mediaBuy.{getProducts, createMediaBuy, updateMediaBuy, syncCreatives, getMediaBuyDelivery}` | `sales-non-guaranteed` / `sales-guaranteed` / `sales-broadcast-tv` / etc. | `sales: SalesPlatform` |
| `mediaBuy.{getMediaBuys, listCreativeFormats, listCreatives, providePerformanceFeedback}` | (same `sales-*`) | `sales: SalesPlatform` (optional methods) |
| `mediaBuy.{syncCatalogs, logEvent, syncEventSources}` | `sales-catalog-driven` | `sales: SalesPlatform` (retail-media optional methods) |
| `creative.{buildCreative, previewCreative, syncCreatives}` | `creative-template` / `creative-generative` / `creative-ad-server` | `creative: CreativeXxxPlatform` |
| `eventTracking.syncAudiences` | `audience-sync` | `audiences: AudiencePlatform` |
| `signals.{getSignals, activateSignal}` | `signal-marketplace` / `signal-owned` | `signals: SignalsPlatform` |
| `governance.{checkGovernance, syncPlans, reportPlanOutcome, getPlanAuditLogs}` | `governance-spend-authority` / `governance-delivery-monitor` | `campaignGovernance: CampaignGovernancePlatform` |
| `governance.{create/list/get/update/deletePropertyList}` | `property-lists` | `propertyLists: PropertyListsPlatform` |
| `governance.{create/list/get/update/deleteCollectionList}` | `collection-lists` | `collectionLists: CollectionListsPlatform` |
| `governance.{create/list/get/update/deleteContentStandards, calibrateContent, validateContentDelivery}` | `content-standards` | `contentStandards: ContentStandardsPlatform` |
| `accounts.*` | (cross-cutting) | `accounts: AccountStore` |
| `brandRights.*` | (deferred to v6.1) | (stays in merge seam) |

### 2. Translate handler bodies

Per-method translation is mostly mechanical:

**v5 (handler returns wire envelope):**
```ts
mediaBuy: {
  getProducts: async (params, ctx) => {
    if (params.brief == null) {
      return adcpError('INVALID_REQUEST', { message: 'brief required', field: 'brief' });
    }
    const products = await myCatalog.lookup(params);
    return { products };
  },
}
```

**v6 (return wire success arm; throw `AdcpError` for rejection):**
```ts
sales: {
  getProducts: async (params, ctx) => {
    if (params.brief == null) {
      throw new AdcpError('INVALID_REQUEST', {
        recovery: 'correctable',
        message: 'brief required',
        field: 'brief',
      });
    }
    return { products: await myCatalog.lookup(params) };
  },
}
```

Differences:
- Throw `AdcpError` instead of returning `adcpError(...)`.
- `recovery` is required on `AdcpError` (not on the v5 envelope).
- Return the success arm directly.

### 3. HITL: rename `createMediaBuy` → `createMediaBuyTask`

If your handler queues for human review, rename to `*Task` and use
`ctx.task` for the framework-issued task id:

```ts
sales: {
  createMediaBuyTask: async (req, ctx) => {
    await this.queueForReview({ taskId: ctx.task.id, request: req });
    const decision = await this.waitForOperator(req);
    if (decision.denied) {
      throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: decision.reason });
    }
    return { media_buy_id: decision.id, status: 'pending_creatives', confirmed_at: new Date().toISOString() };
  },
}
```

`validatePlatform()` rejects defining BOTH `createMediaBuy` and
`createMediaBuyTask` — pick exactly one per pair.

### 4. Account resolution — explicit handling for no-account tools

Some tools (`provide_performance_feedback`, `list_creative_formats`,
`report_usage`, `tasks_get` without explicit account, `get_account_financials`)
don't carry an `account` field on the wire. The framework calls
`accounts.resolve(undefined, { authInfo, toolName })` for these — your
explicit-mode resolver MUST handle the `undefined` ref branch via auth:

```ts
accounts: {
  resolution: 'explicit',
  resolve: async (ref, ctx) => {
    if (ref?.account_id) return await this.db.findById(ref.account_id);
    if (ref?.brand) return await this.db.findByBrand(ref.brand.domain, ref.operator);
    // ref undefined: tool without `account` field on wire — auth-derived path
    if (ctx?.authInfo?.clientId) return await this.db.findByClient(ctx.authInfo.clientId);
    return null; // → ACCOUNT_NOT_FOUND
  },
}
```

### 5. Status changes: replace ad-hoc webhooks with `publishStatusChange`

v5 ad-hoc webhook emission → v6 module-level event bus. Framework
projects to MCP Resources subscribers.

```ts
// v5: manual webhook delivery
await myWebhookEmitter.emit({ url, payload });

// v6:
publishStatusChange({
  account_id: ctx.account.id,
  resource_type: 'media_buy',
  resource_id: buy.media_buy_id,
  payload: { status: 'active' },
  caused_by_request_id: ctx.task?.id,  // optional correlation
  previous_status: 'pending_start',     // optional state-machine assertion
});
```

### 6. Production task storage: wire Postgres registry

In-memory task registry refuses to construct outside `NODE_ENV=test/development`
(production safety). For HITL-eligible production deployments:

```ts
import { createPostgresTaskRegistry, getDecisioningTaskRegistryMigration } from '@adcp/client/server/decisioning';

await pool.query(getDecisioningTaskRegistryMigration());

createAdcpServerFromPlatform(platform, {
  name: '...', version: '...',
  taskRegistry: createPostgresTaskRegistry({ pool }),
});
```

## Common gotchas

- **`accounts.resolve()` is mandatory.** Even single-tenant agents must
  declare `resolution: 'derived'` and return a synthetic singleton. The
  framework calls `resolve()` on every request.
- **`mergeSeam: 'warn'` is the default.** Set `'strict'` in CI to catch
  silent migration regressions where v6.x adds a tool to a specialism
  interface and your prior v5 handler stops running.
- **No-account tools fail silently in explicit mode.** Write the
  `if (ctx?.authInfo?.clientId)` branch in your resolver or single-tenant
  agents will hit `ACCOUNT_NOT_FOUND` on `list_creative_formats` /
  `provide_performance_feedback` / `report_usage`.
- **`AccountNotFoundError`** should be thrown from `accounts.resolve()`,
  not from specialism methods. The framework projects either to
  `ACCOUNT_NOT_FOUND`, but resolve() is the canonical surface.
- **Don't return `Submitted`-style envelopes manually** from `*Task`
  methods. Framework returns the `submitted` envelope to the buyer
  itself; your method's return value becomes the terminal artifact.
- **Postgres registry caps `result` / `error` JSON at 4MB** — return
  per-resource references for large payloads, not the full body.

## What's deferred to v6.1+

- Native MCP `tasks/get` method dispatch (we ship `tasks_get` snake-case
  as a tool today; both surfaces will coexist post-v6.1).
- `BrandRightsPlatform` specialism interface — keep `get_brand_identity`,
  `get_rights`, `acquire_rights`, `update_rights`, `creative_approval` in
  the merge seam (`brandRights` / `customTools`).
- `EventTrackingPlatform` / `CatalogPlatform` / `FinancialsPlatform` as
  separate specialisms — v6.0 routes these tools through `SalesPlatform`
  optional methods.
- `ctx.task.update({ progress })` projection to `tasks_get`'s `progress`
  field — interface ships in v6.0; framework wires the projection in
  v6.1 alongside `taskRegistry.transition()`.
- `*Task` methods for `update_media_buy`, `get_products`, `build_creative`,
  `sync_catalogs` — blocked on a spec inconsistency tracked as
  [adcp#3392](https://github.com/adcontextprotocol/adcp/issues/3392)
  (per-tool response schemas don't include the `Submitted` arm even
  though the corresponding `xxx-async-response-submitted.json` schemas
  exist). When the spec consolidation lands, codegen produces unions
  including `Submitted` and the SDK ships `*Task` methods. Until then,
  long-form flows on those tools surface via `publishStatusChange`.

## Need help?

- SKILL: `skills/build-decisioning-platform/SKILL.md` (canonical adopter shape).
- Worked example: `examples/decisioning-platform-mock-seller.ts`.
- Multi-tenant example: `examples/decisioning-platform-multi-tenant.ts`.
- Broadcast TV / HITL example: `examples/decisioning-platform-broadcast-tv.ts`.
- Existing handler-style API stays at `createAdcpServer` — see
  [`docs/migration-4.x-to-5.x.md`](./migration-4.x-to-5.x.md) for the v4→v5 path.
