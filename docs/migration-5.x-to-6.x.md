# Migrating from `@adcp/sdk` 5.x to 6.0

> **Status: GA.** v6.0 ships under `@adcp/sdk/server/decisioning` —
> `createAdcpServerFromPlatform` + `DecisioningPlatform`. The v5.x
> handler-style API (`createAdcpServer({ mediaBuy: { ... } })`) is the
> substrate the v6 framework calls into and remains fully supported;
> adopters who want finer control over individual handlers can keep
> using it. NEW agents should reach for `createAdcpServerFromPlatform`
> first — it's where compile-time specialism enforcement, capability
> projection, idempotency, signing, async tasks, and status
> normalization come pre-wired. The `mergeSeam` mode lets in-flight
> migrators move one specialism at a time without rewriting the whole
> agent.

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
- **Unified hybrid HITL shape** — `createMediaBuy(req, ctx)` returns
  either the wire `Success` arm (sync fast path) or
  `ctx.handoffToTask(fn)` (HITL slow path). Adopters branch per call:
  programmatic remnant resolves sync, guaranteed inventory hands off to
  background task. No upfront sync-vs-HITL choice — same tool serves
  both. Framework projects the spec-defined `Submitted` envelope to the
  buyer when the adopter hands off.
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
import { createAdcpServerFromPlatform } from '@adcp/sdk/server/decisioning';

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
| `creative.{buildCreative, previewCreative, syncCreatives}` | `creative-template` / `creative-generative` / `creative-ad-server` | `creative: CreativeBuilderPlatform` (template+generative) or `CreativeAdServerPlatform` |
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

### 3. HITL: return `ctx.handoffToTask(fn)` from `createMediaBuy`

There's only one method per tool — `createMediaBuy` (or
`syncCreatives`). To run HITL, return `ctx.handoffToTask(fn)` from
inside the same method. The framework allocates `task_id`, returns the
spec-defined `Submitted` envelope to the buyer, and runs `fn` in the
background.

```ts
sales: {
  createMediaBuy: (req, ctx) => ctx.handoffToTask(async (taskCtx) => {
    await this.queueForReview({ taskId: taskCtx.id, request: req });
    const decision = await this.waitForOperator(req);
    if (decision.denied) {
      throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: decision.reason });
    }
    return { media_buy_id: decision.id, status: 'pending_creatives', confirmed_at: new Date().toISOString(), packages: [] };
  }),
}
```

**Hybrid sellers** (programmatic + guaranteed in one tenant) branch per
call: return the success arm directly for fast paths, return
`ctx.handoffToTask(fn)` for slow paths. Same tool, dynamic dispatch,
predictable wire shape per request.

```ts
createMediaBuy: async (req, ctx) => {
  if (this.isProgrammatic(req)) return await this.commitSync(req);
  return ctx.handoffToTask(async (taskCtx) => await this.runHITL(req, taskCtx.id));
}
```

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
import { createPostgresTaskRegistry, getDecisioningTaskRegistryMigration } from '@adcp/sdk/server/decisioning';

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
- **`mergeSeam: 'strict'` from day 1.** The default is `'warn'` for
  back-compat, but `'strict'` is what you want during migration — it
  surfaces collisions as `PlatformConfigError` at construction time
  instead of as silent runtime UNSUPPORTED_FEATURE responses. Adopters
  who shipped without `strict` and discovered a collision in production
  invariably wished they'd had it on. Set it from the first commit and
  keep it on through GA; the v5-handler-style escape hatches still work
  underneath.
- **`resolveIdempotencyPrincipal` MUST be forwarded to `opts`.** v5.x
  adopters who passed it to `createAdcpServer({ resolveIdempotencyPrincipal })`
  need to pass it to `createAdcpServerFromPlatform` too — the framework
  doesn't synthesize one. Without it, every mutating tool (`create_media_buy`,
  `update_media_buy`, `sync_*`, `acquire_rights`, etc.) returns
  `SERVICE_UNAVAILABLE: Idempotency principal could not be resolved`.
  Symptoms: looks like a transient outage at first run; same call
  consistently fails the second time. Check that `opts.resolveIdempotencyPrincipal`
  is populated before you debug anything else.
- **`ctx.account.authInfo` (specialism methods) vs `ctx.authInfo`
  (`ResolveContext` only).** Inside your `accounts.resolve(ref, ctx)`,
  the second arg is `ResolveContext` and exposes `ctx.authInfo`. Inside
  a `SalesPlatform` / `AudiencePlatform` / etc. method, the second arg
  is `RequestContext` and the auth principal lives at
  `ctx.account.authInfo` — NOT `ctx.authInfo` (which doesn't exist
  there). The migration doc shows the resolver signature first, so
  adopters naturally try the same name in their handler bodies and hit
  a TypeScript error. Distinct shapes; same field, different paths.
- **`mergeSeam: 'warn'` is the default.** Set `'strict'` in CI to catch
  silent migration regressions where v6.x adds a tool to a specialism
  interface and your prior v5 handler stops running.
- **No-account tools fail silently in explicit mode.** Write the
  `if (ctx?.authInfo?.clientId)` branch in your resolver or single-tenant
  agents will hit `ACCOUNT_NOT_FOUND` on `list_creative_formats` /
  `provide_performance_feedback` / `report_usage`.
- **`accounts.resolution: 'explicit'` projects to wire
  `account.require_operator_auth: true`.** The framework derives this bit
  from your declared `resolution` mode (or the explicit
  `capabilities.requireOperatorAuth: true` flag if you set it). Conformance
  storyboards read it to grade `sync_accounts` as `'not_applicable'` for
  explicit-mode adopters who correctly don't implement that tool. If you
  see `sync_accounts` skipped as `'missing_tool'` (rather than
  `'not_applicable'`) on a storyboard run, double-check your
  `accounts.resolution` declaration is actually `'explicit'`.
- **`AccountNotFoundError`** should be thrown from `accounts.resolve()`,
  not from specialism methods. The framework projects either to
  `ACCOUNT_NOT_FOUND`, but resolve() is the canonical surface.
- **Don't return `Submitted`-style envelopes manually** from inside a
  handoff function. Framework returns the `submitted` envelope to the
  buyer itself the moment your method returns `ctx.handoffToTask(fn)`;
  `fn`'s return value becomes the terminal artifact.
- **Postgres registry caps `result` / `error` JSON at 4MB** — return
  per-resource references for large payloads, not the full body.
- **`autoEmitCompletionWebhooks` is on by default (v6.0).** Sync-success
  arms of `create_media_buy` / `update_media_buy` / `sync_creatives`
  auto-fire a completion webhook when the buyer supplied
  `push_notification_config.url`. Fire-and-forget — does not block the
  sync response. Adopters who emit webhooks manually inside their
  handlers (idempotency duplication concern) pass
  `autoEmitCompletionWebhooks: false` on `createAdcpServerFromPlatform`
  to suppress.
- **`allowPrivateWebhookUrls` for sandbox testing.** The framework
  rejects loopback / RFC 1918 / link-local destinations on
  `push_notification_config.url` by default — accepting them in
  production is a SSRF / cloud-metadata exfiltration path. Sandbox /
  local-testing flows that bind webhook receivers to `127.0.0.1`
  pass `allowPrivateWebhookUrls: true`. Construction emits a one-shot
  footgun warn when this is set in production.
- **`buildCreative` discriminated return.** Adopters can return
  `CreativeManifest` (single, no metadata), `CreativeManifest[]`
  (multi-format, no metadata), or a fully-shaped
  `BuildCreativeSuccess` / `BuildCreativeMultiSuccess` envelope (with
  `sandbox` / `expires_at` / `preview`). Route on
  `req.target_format_ids` (multi) vs `req.target_format_id` (single)
  and return the matching arm. Returning the wrong arm fails wire
  schema validation.
- **`npm link` and `undici` peer drift.** The SDK depends on
  `undici@^6.25.0`. Adopters using `npm link` (or `pnpm link`) to point
  at a locally checked-out SDK during migration may find Node walks up
  from the resolved canonical SDK path and binds the host workspace's
  `undici` (often 7.x) instead — the SDK rejects 7.x at startup.
  Workaround: run with `NODE_OPTIONS=--preserve-symlinks` so resolution
  stays inside the SDK's own `node_modules`. Once the SDK is consumed
  via published tarball (`npm install @adcp/sdk@x.y.z`), this
  disappears — link mode is the only setup that triggers it.

## What's deferred to v6.1+

- Native MCP `tasks/get` method dispatch (we ship `tasks_get` snake-case
  as a tool today; both surfaces will coexist post-v6.1).
- `BrandRightsPlatform` specialism interface — keep `get_brand_identity`,
  `get_rights`, `acquire_rights`, `update_rights`, `creative_approval` in
  the merge seam (`brandRights` / `customTools`).
- `EventTrackingPlatform` / `CatalogPlatform` / `FinancialsPlatform` as
  separate specialisms — v6.0 routes these tools through `SalesPlatform`
  optional methods.
- `taskCtx.update({ progress })` projection to `tasks_get`'s `progress`
  field — interface ships in v6.0; framework wires the projection in
  v6.1 alongside `taskRegistry.transition()`.
- Handoff support for `update_media_buy`, `build_creative`, `sync_catalogs`
  — blocked on [adcp#3392](https://github.com/adcontextprotocol/adcp/issues/3392)
  (per-tool response schemas don't include the `Submitted` arm even
  though the corresponding `xxx-async-response-submitted.json` schemas
  exist). When that spec consolidation lands, the unified shape extends
  to those tools. Until then, long-form flows surface via
  `publishStatusChange`.
- `get_products` deliberately stays sync-only even after adcp#3392 lands.
  Catalog lookup and proposal generation are different verbs;
  conflating them under one tool name fights buyer predictability.
  Filed [adcp#3407](https://github.com/adcontextprotocol/adcp/issues/3407)
  advocating a separate `request_proposal` wire tool. Proposal-mode
  adopters surface eventual products via `publishStatusChange` on
  `resource_type: 'proposal'`.

## Need help?

- SKILL: `skills/build-decisioning-platform/SKILL.md` (canonical adopter shape).
- Worked example: `examples/decisioning-platform-mock-seller.ts`.
- Multi-tenant example: `examples/decisioning-platform-multi-tenant.ts`.
- Broadcast TV / HITL example: `examples/decisioning-platform-broadcast-tv.ts`.
- Existing handler-style API stays at `createAdcpServer` — see
  [`docs/migration-4.x-to-5.x.md`](./migration-4.x-to-5.x.md) for the v4→v5 path.
