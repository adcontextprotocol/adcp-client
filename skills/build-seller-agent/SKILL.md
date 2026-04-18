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

## Tools and Required Response Shapes

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
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend', 'clicks'],
      date_range_support: 'date_range',
    },
  }],
  sandbox: true,        // for mock data
})
```

**`create_media_buy`** — `CreateMediaBuyRequestSchema.shape`

Validate the request before creating the buy. Return an error response (not `adcpError`) when business validation fails:

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
    status: 'active' | 'pending_start' | ...,  // required
    currency: 'USD',        // required
    confirmed_at: string,   // required for guaranteed approval — ISO timestamp
    packages: [{
      package_id: string,   // required
    }],
  }]
})
```

**`list_creative_formats`** — `ListCreativeFormatsRequestSchema.shape`

```
listCreativeFormatsResponse({
  formats: [{
    format_id: { agent_url: string, id: string },  // required
    name: string,  // required
  }]
})
```

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
  media_buy_deliveries: [{
    media_buy_id: string,     // required
    status: 'active',         // required
    totals: { impressions: number, spend: number },  // required
    by_package: [],           // required (can be empty)
  }]
})
```

### Context and Ext Passthrough

Every AdCP request includes an optional `context` field. Buyers use it to carry correlation IDs, orchestration metadata, and workflow state across multi-agent calls. Your agent **must** echo the `context` object back unchanged in every response.

```typescript
// In every tool handler:
const context = args.context; // may be undefined — that's fine

// In every response:
return taskToolResponse({
  // ... your response fields ...
  context, // echo it back unchanged
});
```

Do not modify, inspect, or omit the context — treat it as opaque. If the request has no context, omit it from the response.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `sync_governance`, `provide_performance_feedback`, `sync_event_sources`.

## Compliance Testing (Optional)

Add `registerTestController` so the comply framework can deterministically test your state machines. Without it, compliance testing relies on observational storyboards that can't force state transitions.

```
import { registerTestController } from '@adcp/client';
import type { TestControllerStore } from '@adcp/client';

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

When using this, declare `compliance_testing` in `supported_protocols`:

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['media_buy', 'compliance_testing'],
})
```

Only implement the store methods for scenarios your agent supports. Unimplemented methods are excluded from `list_scenarios` automatically.

The storyboard tests state machine correctness:

- `NOT_FOUND` when forcing transitions on unknown entities
- `INVALID_TRANSITION` when transitioning from terminal states (completed, rejected, canceled for media buys; archived blocks active states like processing/pending_review/approved, but archived → rejected is valid)
- Successful transitions between valid states

Throw `TestControllerError` from store methods for typed errors. The SDK validates status enum values before calling your store.

Validate with: `adcp storyboard run <agent> deterministic_testing --json`

### Session-backed stores (factory shape)

**Don't close over module-scoped maps.** If your session state is persisted (Postgres, Redis, JSONB) and rehydrated into a _new_ object per request, a store whose methods close over a module-level `WeakMap<SessionState, …>` or module-scoped cache will silently drop entries between calls — the cached ref was GC'd when the session was serialized out and rebuilt.

Use the factory shape. `scenarios` declares the static capability set — the SDK answers `list_scenarios` from this field and **never invokes `createStore` for capability probes**, so it's safe to throw on missing `session_id`. `createStore` runs per request for every other scenario, returning a store bound to the live session.

```
import {
  registerTestController,
  CONTROLLER_SCENARIOS,
  enforceMapCap,
  TestControllerError,
} from '@adcp/client';

registerTestController(server, {
  scenarios: [
    CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS,
    CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS,
    CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS,
    CONTROLLER_SCENARIOS.SIMULATE_DELIVERY,
    CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND,
  ],
  async createStore(input) {
    const sessionId = (input.context as { session_id?: string })?.session_id;
    if (!sessionId) throw new TestControllerError('INVALID_PARAMS', 'context.session_id is required');
    const session = await loadSession(sessionId);

    return {
      async forceAccountStatus(accountId, status) {
        // enforceMapCap only rejects NET-NEW keys at the cap; updating an
        // existing accountId always passes, so calling it before every set()
        // is safe.
        enforceMapCap(session.accountStatuses, accountId, 'account statuses');
        const prev = session.accountStatuses.get(accountId) ?? 'active';
        session.accountStatuses.set(accountId, status);
        await saveSession(session);
        return { success: true, previous_state: prev, current_state: status };
      },

      async forceMediaBuyStatus(mediaBuyId, status) {
        const prev = session.mediaBuyStatuses.get(mediaBuyId);
        if (!prev) throw new TestControllerError('NOT_FOUND', `Media buy ${mediaBuyId} not found`);
        const terminal = ['completed', 'rejected', 'canceled'];
        if (terminal.includes(prev)) {
          throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from ${prev}`, prev);
        }
        enforceMapCap(session.mediaBuyStatuses, mediaBuyId, 'media buy states');
        session.mediaBuyStatuses.set(mediaBuyId, status);
        await saveSession(session);
        return { success: true, previous_state: prev, current_state: status };
      },

      // ...implement other scenarios from your `scenarios` list the same way
    };
  },
});
```

### Cap per-session maps

Wrap every `Map.set` on session-scoped state with `enforceMapCap` to reject unbounded growth with a typed `INVALID_STATE` error (vs. silent LRU eviction, which would make compliance tests nondeterministic). Existing-key overwrites always pass — only _net-new_ keys are rejected at the cap. Default cap is `SESSION_ENTRY_CAP` (1000).

### Custom MCP wrappers

If you need `AsyncLocalStorage`, sandbox gating, or a custom task store around the controller tool, bypass `registerTestController` and call the exported building blocks directly. `toMcpResponse` and `TOOL_INPUT_SHAPE` are the exact pieces the default registration uses — reusing them keeps the envelope shape identical.

```
import { AsyncLocalStorage } from 'node:async_hooks';
import { handleTestControllerRequest, toMcpResponse, TOOL_INPUT_SHAPE } from '@adcp/client';

const sessionContext = new AsyncLocalStorage<{ sessionId: string }>();
const store = { async forceAccountStatus(id, status) { /* ... */ } };

server.tool('comply_test_controller', 'Sandbox only.', TOOL_INPUT_SHAPE, async input => {
  if (!sandboxEnabled()) {
    return toMcpResponse({ success: false, error: 'FORBIDDEN', error_detail: 'Sandbox disabled' });
  }
  const sessionId = (input.context as { session_id: string }).session_id;
  return sessionContext.run({ sessionId }, async () => {
    const response = await handleTestControllerRequest(store, input as Record<string, unknown>);
    return toMcpResponse(response);
  });
});
```

## SDK Quick Reference

| SDK piece                                                                 | Usage                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `createAdcpServer(config)`                                                | Domain-grouped server — auto-wires schemas, response builders, capabilities    |
| `serve(() => createAdcpServer(config))`                                   | Start HTTP server on `:3001/mcp`                                               |
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

Response builders (`productsResponse`, `mediaBuyResponse`, `deliveryResponse`, etc.) are auto-applied by `createAdcpServer` — you return the data, the framework wraps it. You only need to call them directly for tools without a dedicated builder.

Import everything from `@adcp/client`. Types from `@adcp/client` with `import type`.

## Setup

```bash
npm init -y
npm install @adcp/client
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

Use `createAdcpServer` — it auto-wires schemas, response builders, and `get_adcp_capabilities` from the handlers you provide. Handlers receive `(params, ctx)` where `ctx.store` persists state and `ctx.account` is the resolved account.

```typescript
import {
  createAdcpServer,
  serve,
  adcpError,
  InMemoryStateStore,
  checkGovernance,
  governanceDeniedError,
  DEFAULT_REPORTING_CAPABILITIES,
} from '@adcp/client';
import type { ServeContext } from '@adcp/client';

const stateStore = new InMemoryStateStore(); // shared across requests

function createAgent({ taskStore }: ServeContext) {
  return createAdcpServer({
    name: 'My Seller Agent',
    version: '1.0.0',
    taskStore,
    stateStore,

    resolveAccount: async ref => {
      if ('account_id' in ref) return stateStore.get('accounts', ref.account_id);
      return null; // or resolve by brand+operator
    },

    accounts: {
      syncAccounts: async (params, ctx) => {
        /* ... */
      },
    },
    mediaBuy: {
      getProducts: async (params, ctx) => {
        return { products: PRODUCTS, sandbox: true };
        // productsResponse() auto-applied by framework
      },
      createMediaBuy: async (params, ctx) => {
        // Governance check for financial commitment
        if (ctx.account?.governanceUrl) {
          const gov = await checkGovernance({
            agentUrl: ctx.account.governanceUrl,
            planId: params.plan_id ?? 'default',
            caller: 'https://my-agent.com/mcp',
            tool: 'create_media_buy',
            payload: params,
          });
          if (!gov.approved) return governanceDeniedError(gov);
        }
        const buy = {
          media_buy_id: `mb_${Date.now()}`,
          status: 'pending_creatives',
          packages:
            params.packages?.map((pkg, i) => ({
              package_id: `pkg_${i}`,
              product_id: pkg.product_id,
              pricing_option_id: pkg.pricing_option_id,
              budget: pkg.budget,
            })) ?? [],
        };
        await ctx.store.put('media_buys', buy.media_buy_id, buy);
        return buy; // mediaBuyResponse() auto-applied (sets revision, confirmed_at, valid_actions)
      },
      getMediaBuys: async (params, ctx) => {
        const result = await ctx.store.list('media_buys');
        return { media_buys: result.items };
      },
      getMediaBuyDelivery: async (params, ctx) => {
        /* ... */
      },
      listCreativeFormats: async (params, ctx) => {
        /* ... */
      },
      syncCreatives: async (params, ctx) => {
        /* ... */
      },
    },
    capabilities: {
      features: { inlineCreativeManagement: false },
    },
  });
}

serve(createAgent);
```

Key points:

1. Single `.ts` file — all domain handlers in one `createAdcpServer` call
2. `get_adcp_capabilities` is auto-generated from your handlers — don't register it manually
3. Response builders are auto-applied — just return the data
4. Use `ctx.store` for state — persists across stateless HTTP requests
5. Set `sandbox: true` on all mock/demo responses
6. Use `adcpError()` for business validation failures
7. Use `as const` on string literal arrays and union-typed fields in product definitions — TypeScript infers `string[]` from `['display', 'olv']` but the SDK requires specific union types like `MediaChannel[]`. Apply `as const` to `channels`, `delivery_type`, `selection_type`, and `pricing_model` values.

The skill contains everything you need. Do not read additional docs before writing code.

## Validation

**After writing the agent, validate it. Fix failures. Repeat.**

**Full validation** (if you can bind ports):

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp media_buy_seller --json
```

**Sandbox validation** (if ports are blocked):

```bash
npx tsc --noEmit
```

When storyboard output shows failures, fix each one:

- `response_schema` → response doesn't match Zod schema
- `field_present` → required field missing
- MCP error → check tool registration (schema, name)

**Keep iterating until all steps pass.**

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

| Mistake                                                    | Fix                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Using `createTaskCapableServer` + `server.tool()`          | Use `createAdcpServer` — handles schemas, response builders, capabilities                                                                                                        |
| Using module-level Maps for state                          | Use `ctx.store` — persists across HTTP requests, swappable for postgres                                                                                                          |
| Return raw JSON without response builders                  | `createAdcpServer` auto-applies response builders — just return the data                                                                                                         |
| Missing `brand`/`operator` in sync_accounts response       | Echo them back from the request — they're required                                                                                                                               |
| sync_governance returns wrong shape                        | Must include `status: 'synced'` and `governance_agents` array                                                                                                                    |
| `sandbox: false` on mock data                              | Buyers may treat mock data as real                                                                                                                                               |
| Returns raw JSON for validation failures                   | Use `adcpError('INVALID_REQUEST', { message })` — storyboards validate the `adcp_error` structure                                                                                |
| Missing `publisher_properties` or `format_ids` on Product  | Both are required — see product example in `get_products` section                                                                                                                |
| format_ids in products don't match list_creative_formats   | Buyers echo format_ids from products into sync_creatives — if your validation rejects your own format_ids, the buyer can't fulfill creative requirements                         |
| Missing `@types/node` in devDependencies                   | `process.env` doesn't resolve without it — see Setup section                                                                                                                     |
| Dropping `context` from responses                          | Echo `args.context` back unchanged in every response — buyers use it for correlation                                                                                             |
| `channels` typed as `string[]` instead of `MediaChannel[]` | Use `as const` on channel arrays: `channels: ['display', 'olv'] as const`. TypeScript infers `string[]` from array literals, but the SDK requires the `MediaChannel` union type. |

## Reference

- `docs/guides/BUILD-AN-AGENT.md` — createAdcpServer patterns, async tools, state persistence
- `docs/llms.txt` — full protocol reference
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `storyboards/media_buy_seller.yaml` — full buyer interaction sequence
- `examples/error-compliant-server.ts` — seller with error handling
- `src/lib/server/create-adcp-server.ts` — framework source (for TypeScript autocomplete exploration)
