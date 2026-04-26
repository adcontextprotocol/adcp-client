# DecisioningPlatform v3: locked design

**Status**: Locked architecture; companion TypeScript file at `src/lib/server/decisioning/` is authoritative for shapes
**Target version**: 6.0 (single-cut migration; no 5.x deprecation cycle)
**Supersedes**: v1, v2, v2.1
**Round 2 review**: 4 experts, all 5 showstoppers + 5 should-fixes integrated

## What changed v2.1 → v3

Three architectural decisions plus 10 surgical fixes.

### Architectural decisions

1. **Async is universal.** Every decision-point method that can be slow returns `AsyncOutcome<T>` — not just `createMediaBuy`. Creative review (Innovid 4-72h SLAs), brand-rights approval, signal activation, large delivery reports — all use the same pattern. One discriminated union, one task envelope mechanism, one webhook-or-poll completion path.

2. **v1.0 ships sales-non-guaranteed.** Phasing v1.0 to creative-only would prove the easy half then discover the hard half is wrong (3 of 4 reviewers agreed). v1.0 = **creative-template + creative-generative + audience-sync + sales-non-guaranteed**. The hard contract gets exercised at launch.

3. **Single-cut migration to 6.0.** No 5.x deprecation runway. Production user count on 5.x is small enough to absorb a clean break; the engineering cost of dual-shipping handler-style + platform-style for 18 months exceeds the migration cost. ~8 weeks of focused SDK work to ship 6.0.

### Surgical fixes (round 2 expert findings)

| # | Fix | Source |
|---|---|---|
| 1 | Drop `MediaBuyOutcome.kind: 'pending_creatives'` — `MediaBuy.status` carries the wire enum verbatim; outcome kind is just `sync \| submitted \| rejected` | Protocol expert (showstopper) |
| 2 | Type `rejected.error.code` as `ErrorCode \| (string & {})` (45 standard codes from `error-code.json`); require `recovery: 'transient' \| 'correctable' \| 'terminal'` | Protocol expert (showstopper) |
| 3 | Add `notify(taskHandle, update)` callback so platforms push terminal state from their own webhooks; framework polling becomes fallback | Product expert (rate-limit reality) |
| 4 | `StatusMappers { account, mediaBuy, creative, plan }` dataclass on platform — single `mapStatus` was wrong-grained | Product + DX |
| 5 | Construction-time validation = **warn by default**; `--strict` flag fails | Product expert |
| 6 | Outcome construction helpers: `okOutcome(result)` / `submittedOutcome(handle)` / `rejectedOutcome(error)` | DX + Architect |
| 7 | Rename `findProposalByProductId` → `findProposalById(proposalId)` (proposal_id is the wire concept) | Protocol expert |
| 8 | Split `ctx.workflow` into `ctx.state.*` (sync state reads) + `ctx.resolve.*` (async resolvers) | DX |
| 9 | `DecisioningCapabilities<TConfig = unknown>` and `Account<TMeta = unknown>` generics for platform-specific typing | DX + Product |
| 10 | `creative_agents.format_ids?: string[]` filter scope: filter applies to ONE creative agent's catalog — worked example in companion file | Product |

## Architecture (locked)

```
┌─────────────────────────────────────────────────────────────────┐
│ Framework (@adcp/client v6)                                      │
│  Wire-protocol: validate / route / wrap responses                │
│  Async machinery (UNIVERSAL — every AsyncOutcome surface):       │
│    - task envelope generation (kind: 'submitted')                │
│    - notify(taskHandle, update) ingress (webhook push)           │
│    - poll(taskHandle) fallback (when platform doesn't push)      │
│    - completion webhook emission to push_notification_config.url │
│    - retry / dedup / replay-safety                               │
│  Lifecycle state (ctx.state.* / ctx.resolve.*):                  │
│    - findByObject(type, id) → workflow steps that touched it     │
│    - findProposalById(proposalId) → proposal context             │
│    - resolvePropertyList / resolveCollectionList → async fetch   │
│    - governanceContext() → JWS (verified by framework first)     │
│  Cross-cutting: idempotency, auth, signed-requests verification  │
│  Composition: auto-call check_governance for governance-aware    │
└────────────────────┬────────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────────┐
│ DecisioningPlatform<TConfig>                                     │
│   capabilities: DecisioningCapabilities<TConfig>                 │
│     - specialisms                                                │
│     - creative_agents: [{ agent_url, format_ids? }]              │
│     - channels, pricingModels, targeting?, reporting?            │
│     - config: TConfig (typed; platform-specific)                 │
│                                                                  │
│   accounts: AccountStore                                         │
│   statusMappers: StatusMappers (account / mediaBuy / creative)   │
│                                                                  │
│   sales?:        SalesPlatform                                   │
│   creative?:     CreativePlatform                                │
│   signals?:      SignalsPlatform                                 │
│   audiences?:    AudiencePlatform                                │
│   governance?:   GovernancePlatform                              │
│   brand?:        BrandRightsPlatform                             │
└─────────────────────────────────────────────────────────────────┘
```

## The universal async pattern

Every decision-point method that can be slow returns:

```ts
type AsyncOutcome<TResult, TError extends AdcpStructuredError = AdcpStructuredError> =
  | { kind: 'sync'; result: TResult }
  | { kind: 'submitted'; taskHandle: TaskHandle; estimatedCompletion?: Date; message?: string }
  | { kind: 'rejected'; error: TError };

interface AdcpStructuredError {
  code: ErrorCode | (string & {});  // 45 standard codes from error-code.json + escape hatch
  recovery: 'transient' | 'correctable' | 'terminal';
  message: string;
  details?: Record<string, unknown>;
}

interface TaskHandle {
  taskId: string;
  // Platform-controlled completion. When platform's backend learns the task
  // is done (via its own webhook from GAM/Innovid/etc.), it calls notify()
  // with the terminal update; framework polls only as fallback.
  notify(update: TaskUpdate<TResult, TError>): void;
}

type TaskUpdate<TResult, TError = AdcpStructuredError> =
  | { kind: 'progress'; status?: string; percent?: number }
  | { kind: 'completed'; result: TResult }
  | { kind: 'failed'; error: TError };
```

Methods that always-sync (e.g., `getProducts`, `validateApproval`) return `Promise<TResult>` directly — no AsyncOutcome wrap. Async-eligible methods that mostly-sync (e.g., `updateMediaBuy` for simple bid changes) still wrap in AsyncOutcome so the platform can return `{ kind: 'submitted' }` when the patch triggers an approval workflow.

**Helpers** (exported from `@adcp/client/server/decisioning`):

```ts
export function ok<T>(result: T): AsyncOutcome<T> { ... }
export function submitted<T>(handle: TaskHandle, options?: { estimatedCompletion?: Date; message?: string }): AsyncOutcome<T> { ... }
export function rejected<T>(error: AdcpStructuredError): AsyncOutcome<T> { ... }

// Platform code becomes:
return ok(buy);
return submitted(handle, { estimatedCompletion: in4Hours });
return rejected({ code: 'TERMS_REJECTED', recovery: 'correctable', message: '...' });
```

## v1.0 specialism interfaces (4 of 17)

Full TypeScript shapes are in the companion file at `src/lib/server/decisioning/`. Sketch here:

### CreativeTemplatePlatform

```ts
interface CreativeTemplatePlatform {
  buildCreative(req: BuildCreativeRequest, account: Account): Promise<AsyncOutcome<CreativeManifest>>;
  previewCreative(req: PreviewCreativeRequest, account: Account): Promise<AsyncOutcome<PreviewResult>>;
  syncCreatives(creatives: Creative[], account: Account): Promise<AsyncOutcome<CreativeReviewResult[]>>;
}
```

3 methods. Synchronous case completes in 5 lines per method. Audio (AudioStack), display, generic templates all fit.

### CreativeGenerativePlatform

```ts
interface CreativeGenerativePlatform {
  buildCreative(req: BuildCreativeRequest, account: Account): Promise<AsyncOutcome<CreativeManifest>>;
  refineCreative(taskId: string, refinement: RefinementMessage, account: Account): Promise<AsyncOutcome<CreativeManifest>>;
  syncCreatives(creatives: Creative[], account: Account): Promise<AsyncOutcome<CreativeReviewResult[]>>;
}
```

Async-by-default: `buildCreative` typically returns `submitted` because TTS / image generation takes seconds-to-minutes. Framework polls or platform pushes via `notify`.

### AudiencePlatform

```ts
interface AudiencePlatform {
  syncAudiences(audiences: Audience[], account: Account): Promise<AsyncOutcome<AudienceSyncResult[]>>;
  getAudienceStatus(audienceId: string, account: Account): Promise<AudienceStatus>;
  // listAccounts is on AccountStore (cross-cutting)
}
```

LiveRamp-class platforms return `submitted` for activation; match-rate computation is async. Status query is sync read.

### SalesPlatform

```ts
interface SalesPlatform {
  getProducts(req: GetProductsRequest, account: Account): Promise<GetProductsResult>;
  createMediaBuy(req: CreateMediaBuyRequest, account: Account): Promise<AsyncOutcome<MediaBuy>>;
  updateMediaBuy(buyId: string, patch: UpdateMediaBuyRequest, account: Account): Promise<AsyncOutcome<MediaBuy>>;
  syncCreatives(creatives: Creative[], account: Account): Promise<AsyncOutcome<CreativeReviewResult[]>>;
  getMediaBuyDelivery(filter: GetMediaBuyDeliveryRequest, account: Account): Promise<AsyncOutcome<DeliveryActuals>>;
}
```

Five methods. Each maps 1:1 to an AdCP wire tool. `getProducts` is sync (discovery returns fast); the rest can submit. `MediaBuyOutcome` overspecification is gone — `kind` is `sync | submitted | rejected`; `MediaBuy.status` carries `pending_creatives | pending_start | active` from the wire enum.

## Lifecycle state primitives

Split into two namespaces by semantics (DX expert fix):

```ts
interface RequestContext<TAccount = Account> {
  account: TAccount;
  authInfo: AuthPrincipal;

  // Sync state reads — what the framework knows about this in-flight request
  state: {
    findByObject(type: WorkflowObjectType, id: string): WorkflowStep[];
    findProposalById(proposalId: string): Proposal | null;
    governanceContext(): GovernanceContextJWS | null;  // pre-verified by framework
    workflowSteps(): WorkflowStep[];  // chronological for this account
  };

  // Async resolvers — framework-mediated lookups
  resolve: {
    propertyList(listId: string): Promise<PropertyList>;
    collectionList(listId: string): Promise<CollectionList>;
    creativeFormat(formatId: FormatID): Promise<Format>;  // resolved through creative_agents config
  };
}
```

Platform reads via `ctx.state.*` (sync) and `ctx.resolve.*` (async). Framework owns writes; platform never mutates either.

## DecisioningCapabilities (typed config)

```ts
interface DecisioningCapabilities<TConfig = unknown> {
  specialisms: AdCPSpecialism[];

  creative_agents: {
    agent_url: string;
    name?: string;
    format_ids?: string[];  // filter to subset of THIS agent's format catalog
  }[];

  channels: MediaChannel[];
  pricingModels: PricingModel[];
  targeting?: TargetingCapabilities;
  reporting?: ReportingCapabilities;

  // Platform-specific config — strongly typed when adopter uses the generic.
  // Example: GAMDecisioningPlatform extends DecisioningPlatform<{ networkId: string }>
  config: TConfig;
  configSchema?: ZodSchema<TConfig>;  // optional runtime validation hook
}
```

## Account (single-level, generic metadata)

```ts
interface Account<TMeta = Record<string, unknown>> {
  id: string;                                     // your platform's account_id
  brand?: BrandReference;
  operator?: string;
  metadata: TMeta;                                // platform-typed extension
  authInfo: AuthPrincipal;
}

interface StatusMappers {
  account?(native: string): AdcpAccountStatus;
  mediaBuy?(native: string): AdcpMediaBuyStatus;
  creative?(native: string): AdcpCreativeStatus;
  plan?(native: string): AdcpPlanStatus;
}
```

Platform implementation:

```ts
class GAMDecisioningPlatform implements DecisioningPlatform<GAMConfig> {
  capabilities: DecisioningCapabilities<GAMConfig> = {
    specialisms: ['sales-non-guaranteed'],
    creative_agents: [
      { agent_url: 'https://creative.adcontextprotocol.org/mcp', format_ids: ['display_image', 'display_html'] },
      { agent_url: 'https://celtra.example/mcp' },
    ],
    channels: ['display', 'video'],
    pricingModels: ['cpm'],
    config: { networkId: '12345', /* ... */ },
  };

  statusMappers: StatusMappers = {
    mediaBuy: (gamStatus) => ({ DRAFT: 'pending_creatives', APPROVED: 'active', /* ... */ })[gamStatus],
    creative: (gamStatus) => ({ /* ... */ })[gamStatus],
  };

  accounts: AccountStore<{ networkId: string; advertiserId: string }> = ...;
  sales: SalesPlatform = ...;
}
```

## Compile-time capability enforcement

```ts
type RequiredPlatformsFor<S extends AdCPSpecialism> =
  | (S extends 'creative-template' ? { creative: CreativeTemplatePlatform } : never)
  | (S extends 'creative-generative' ? { creative: CreativeGenerativePlatform } : never)
  | (S extends 'sales-non-guaranteed' ? { sales: SalesPlatform } : never)
  | (S extends 'audience-sync' ? { audiences: AudiencePlatform } : never);
  // ... extended in v1.1+

declare function createAdcpServer<P extends DecisioningPlatform>(config: {
  platform: P & RequiredPlatformsFor<P['capabilities']['specialisms'][number]>;
}): AdcpServer;
```

Drop a method, fail compile. Claim a specialism without an implementation, fail compile. The `& RequiredPlatformsFor<...>` intersection forces every claimed specialism's interface methods to exist.

## Migration plan (single-cut)

| Version | Change | Breaking? |
|---|---|---|
| 5.x (current) | Handler-style API; `ctx.store` exists | — |
| 6.0 | DecisioningPlatform is the only API. Handler-style and `ctx.store` removed. AsyncOutcome universal. | **Yes** |

Estimated SDK work: **~8 weeks** of focused engineering.
- Week 1: Companion TypeScript file lands as `src/lib/server/decisioning/` preview (this PR)
- Weeks 2-3: Framework wiring (AsyncOutcome routing, notify ingress, ctx.state/resolve, status mappers)
- Weeks 4-5: 4 v1.0 specialism implementations + MockDecisioningPlatform + tests
- Weeks 6-7: Compliance fixtures + matrix harness rewrite against MockDecisioningPlatform
- Week 8: Migrate examples, training-agent, sample agents; cut 6.0

Production 5.x adopters migrate in a single window.

## What's NOT in this proposal

- **6.0 cutover branch policy** — separate doc
- **v1.1+ specialism shapes** — addressed at v1.0 ship time
- **Buyer-side typed client coverage** — implicit; companion TS will mark which types are shared seller↔buyer
- **Mock-platform package decision** — settled as `@adcp/client/mock` sub-export (DX vote)

## Next move

Companion file `src/lib/server/decisioning/index.ts` (full TypeScript). Then training-agent migration sketch. Then this scaffold PR.

The locked architecture goes into the type system. That's where the next round of review happens.

## Post-validation amendments

Three migration sketches against real adapter codebases (training-agent, GAM, `scope3data/agentic-adapters`, `prebid/salesagent`) surfaced convergent gaps. The following amendments have been applied to the type scaffold without changing the architecture:

- **`TargetingCapabilities`** (`capabilities.ts`) — placeholder replaced with the per-geo-system shape Scope3 and Prebid both shipped independently. Includes `geo_metros`, `geo_postal_areas`, `geo_proximity`, `age_restriction.verification_methods`, `keyword_targets.supported_match_types`, `negative_keywords.supported_match_types`. Two independent peer codebases converged on this — strong signal.
- **`ReportingCapabilities.availableDimensions`** — added typed enum (`'geo' | 'device_type' | 'audience' | 'placement' | 'creative' | 'keyword' | 'catalog_item' | 'device_platform'`).
- **`AccountStore.resolution`** — added `'explicit' | 'implicit'` flag. LinkedIn requires pre-sync (`'implicit'`); GAM/Snap/Meta accept inline `account_id` (`'explicit'`). Defaults to `'explicit'`.
- **`AccountNotFoundError`** (`account.ts`) — added throw-class for adopters who prefer throw-based not-found signaling. Framework catches and emits the same fixed `ACCOUNT_NOT_FOUND` envelope. Documented narrow-use semantics: never use for upstream-API outages or schema-validation failures.
- **`DecisioningCapabilities.supportedBillings` + `requireOperatorAuth`** — added for operator-billed retail-media platforms (Criteo, Amazon).
- **JSDoc clarifications**: `TaskUpdate` is monotonic (bounce-back becomes `failed` + `recovery: 'correctable'` + new task envelope on the buyer's retry); `StatusMappers` is wire-status decoder, not rollup engine; `updateMediaBuy` patches dispatch locally to action verbs in adapter code; framework intercepts `dry_run` and platforms never see dry-run traffic.

Pricing-model enum already covers all 9 AdCP values (`cpm | vcpm | cpc | cpcv | cpv | cpp | cpa | flat_rate | time`); no change needed.

## Round-5/6 refactor: throw-`AdcpError` adopter shape

After parallel JS + DX expert review (round 5) and direct adopter feedback from Prebid + Scope3 (round 4), the **adopter-facing surface shifted from `AsyncOutcome<T>`-as-default-return to plain `Promise<T>` with `throw AdcpError` for structured rejection**. Rationale: AsyncOutcome is idiosyncratic in the TS server ecosystem (tRPC / Express / GraphQL all use plain async + throw); the per-method `ok()`/`rejected()` ceremony was a tax on every sync happy path; agent-generated code mixed return shapes.

### New canonical adopter shape

```ts
sales: SalesPlatform = {
  // Sync happy path: just await and return.
  getProducts: async (req, ctx) => ({ products: this.lookup(req.brief) }),

  createMediaBuy: async (req, ctx) => {
    // Structured rejection: throw.
    if (req.total_budget.amount < this.floor) {
      throw new AdcpError('BUDGET_TOO_LOW', {
        recovery: 'correctable',
        message: `Floor is $${this.floor} CPM`,
        field: 'total_budget.amount',
      });
    }

    // In-process async: ctx.runAsync races against framework timeout.
    if (this.requiresOperatorReview(req)) {
      return await ctx.runAsync(
        { message: 'Awaiting approval', partialResult: pendingBuy },
        async () => await this.waitForOperatorApproval(req)
      );
    }

    // Sync.
    return await this.platform.create(req);
  },
};
```

### Three rules

1. Methods return `Promise<T>` directly. No `ok()` / `submitted()` / `rejected()` wrappers in adopter code.
2. `throw new AdcpError(code, opts)` for buyer-facing structured rejection. Generic thrown errors fall through to `SERVICE_UNAVAILABLE`.
3. For in-process async: `await ctx.runAsync(opts, fn)`. For out-of-process: `ctx.startTask()` + `server.completeTask(taskId, result)` (out-of-process notify path).

### What stays internal

`AsyncOutcome<T>` and its `ok` / `submitted` / `rejected` constructors remain in the runtime as **internal projection vocabulary**. Adopter code never sees them; the runtime constructs `AsyncOutcome` literals when projecting platform results onto the wire.

### What's added

- **`AdcpError`** class — throwable structured error carrying `code`, `recovery`, `field?`, `suggestion?`, `retry_after?`, `details?`. Mirrors `schemas/cache/3.0.0/core/error.json`. Required field: `recovery` (the wire schema makes it optional, but every adopter needs to declare buyer-recovery intent on every rejection).
- **`ctx.runAsync(opts, fn)`** — in-process async opt-in. Races `fn()` against `submittedAfterMs` (default 30s). Fast path: returns the value normally (sync wire arm). Slow path: throws internal `TaskDeferredError` (the runtime catches and projects to submitted envelope with `task_id` / `message` / `partial_result`); meanwhile `fn()` keeps running and notifies the registry on resolve/throw.
- **`ctx.startTask(opts?)`** — out-of-process async explicit. Returns a `TaskHandle` whose `taskId` is framework-issued. Adopter persists the taskId; webhook handler later calls `notify` directly (or `server.completeTask` once the wire path lands).
- **`server.getTaskState(taskId)`** — read the registry record (status, result, error, partialResult, statusMessage, timestamps). The API the forthcoming `tasks/get` wire handler plugs into.
- **`server.awaitTask(taskId)`** — await any registered background completion. Used by tests + the wire path for deterministic settlement.

### Production hardening (round-6)

- **`NODE_ENV` gate on default in-memory task registry**. Allowlist: `NODE_ENV=test` or `NODE_ENV=development`. Anything else (including unset; production may unset NODE_ENV) → refuse construction. Override: pass `taskRegistry` explicitly. Emergency hatch: `ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1`. Pattern follows `feedback_node_env_allowlist.md`.
- **Slow-pending-start warning**. When `createMediaBuy` returns sync (no `runAsync`) AND elapsed > 30s AND result carries `status: 'pending_start'`, log a warning suggesting `ctx.runAsync({ partialResult }, ...)`. Catches adopters who silently regress buyer UX by awaiting hours inside `createMediaBuy`.

### Worked example + skill

- **MockSeller worked example**: `examples/decisioning-platform-mock-seller.ts` demonstrates four real-world async patterns (in-process trafficker approval via `ctx.runAsync`, out-of-process via `ctx.startTask`, partial-batch creative review, multi-error pre-flight rejection). Doubles as integration tests in `test/server-decisioning-mock-seller.test.js`.
- **Skill**: `skills/build-decisioning-platform/SKILL.md` — focused (~250 lines vs the legacy build-seller-agent's 1397) walkthrough of the new shape.

### Migration

`docs/proposals/decisioning-platform-training-agent-migration.md` updated to use the new shape. Other migration sketches (GAM, Scope3, Prebid) preserve their original code style for historical reference; all four migrations remain valid against the new shape with mechanical substitutions (`ok(buy)` → `buy`; `rejected({...})` → `throw new AdcpError(...)`; `submitted({...})` → `await ctx.runAsync({...}, fn)`).
