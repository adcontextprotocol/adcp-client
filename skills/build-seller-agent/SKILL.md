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

- Name and description
- Channel: `display`, `olv`, `ctv`, `social`, `retail_media`, `dooh`, etc.
- Creative format requirements
- At least one pricing option

Pricing models:

- `cpm` — `{ pricing_model: "cpm", fixed_price: 12.00, currency: "USD" }`
- `cpc` — `{ pricing_model: "cpc", fixed_price: 1.50, currency: "USD" }`
- Auction — `{ pricing_model: "cpm", floor_price: 5.00, currency: "USD" }` (buyer bids above floor)

Each pricing option can set `min_spend_per_package` to enforce minimum budgets.

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
  products: Product[],  // required - each needs product_id, delivery_type, pricing_options
  sandbox: true,        // for mock data
})
```

**`create_media_buy`** — `CreateMediaBuyRequestSchema.shape`

```
mediaBuyResponse({
  media_buy_id: string,       // required
  packages: [{                // required
    package_id: string,
    product_id: string,
    pricing_option_id: string,
    budget: number,
  }],
})
```

**`get_media_buys`** — `GetMediaBuysRequestSchema.shape`

```
getMediaBuysResponse({
  media_buys: [{
    media_buy_id: string,   // required
    status: 'active' | 'pending_start' | ...,  // required
    currency: 'USD',        // required
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
    if (prev === 'archived')
      throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from archived`, prev);
    creatives.set(creativeId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async simulateDelivery(mediaBuyId, params) {
    // Accumulate delivery data and return simulated + cumulative totals
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
- `INVALID_TRANSITION` when transitioning from terminal states (completed, rejected, canceled for media buys; archived for creatives)
- Successful transitions between valid states

Throw `TestControllerError` from store methods for typed errors. The SDK validates status enum values before calling your store.

Validate with: `adcp storyboard run <agent> deterministic_testing --json`

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `serve(createAgent)`                                    | Start HTTP server on `:3001/mcp`                                    |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support                                 |
| `server.tool(name, Schema.shape, handler)`              | Register tool — `.shape` unwraps Zod for MCP SDK                    |
| `capabilitiesResponse(data)`                            | Build `get_adcp_capabilities` response                              |
| `productsResponse(data)`                                | Build `get_products` response                                       |
| `mediaBuyResponse(data)`                                | Build `create_media_buy` response                                   |
| `updateMediaBuyResponse(data)`                          | Build `update_media_buy` response                                   |
| `getMediaBuysResponse(data)`                            | Build `get_media_buys` response                                     |
| `deliveryResponse(data)`                                | Build `get_media_buy_delivery` response                             |
| `listAccountsResponse(data)`                            | Build `list_accounts` response                                      |
| `listCreativeFormatsResponse(data)`                     | Build `list_creative_formats` response                              |
| `syncCreativesResponse(data)`                           | Build `sync_creatives` response                                     |
| `taskToolResponse(data, summary)`                       | Build generic tool response (for tools without a dedicated builder) |
| `adcpError(code, { message })`                          | Structured error (e.g., `BUDGET_TOO_LOW`, `PRODUCT_NOT_FOUND`)      |
| `registerTestController(server, store)`                 | Add `comply_test_controller` for deterministic testing              |
| `TestControllerError(code, message)`                    | Typed error from store methods                                      |

Import everything from `@adcp/client`. Types from `@adcp/client` with `import type`.

## Setup

```bash
npm init -y
npm install @adcp/client
```

## Implementation

1. Single `.ts` file — all tools in one file
2. Always register `get_adcp_capabilities` as the **first** tool with empty `{}` schema
3. Use `Schema.shape` (not `Schema`) when registering tools
4. Use response builders — never return raw JSON
5. Set `sandbox: true` on all mock/demo responses
6. Use `ServeContext` pattern: `function createAgent({ taskStore }: ServeContext)` and pass `taskStore` to `createTaskCapableServer`

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
npx tsc --noEmit agent.ts
```

When storyboard output shows failures, fix each one:

- `response_schema` → response doesn't match Zod schema
- `field_present` → required field missing
- MCP error → check tool registration (schema, name)

**Keep iterating until all steps pass.**

## Storyboards

| Storyboard                      | Use case                                       |
| ------------------------------- | ---------------------------------------------- |
| `media_buy_seller`              | Full lifecycle — every seller should pass this |
| `media_buy_non_guaranteed`      | Auction flow with bid adjustment               |
| `media_buy_guaranteed_approval` | IO approval workflow                           |
| `media_buy_proposal_mode`       | AI-generated proposals                         |
| `media_buy_catalog_creative`    | Catalog sync + conversions                     |

## Common Mistakes

| Mistake                                              | Fix                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| Pass `Schema` instead of `Schema.shape`              | MCP SDK needs unwrapped Zod fields                            |
| Skip `get_adcp_capabilities`                         | Must be the first tool registered                             |
| Return raw JSON without response builders            | LLM clients need the text content layer                       |
| Missing `brand`/`operator` in sync_accounts response | Echo them back from the request — they're required            |
| sync_governance returns wrong shape                  | Must include `status: 'synced'` and `governance_agents` array |
| `sandbox: false` on mock data                        | Buyers may treat mock data as real                            |

## Reference

- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns and async tools
- `docs/llms.txt` — full protocol reference
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `storyboards/media_buy_seller.yaml` — full buyer interaction sequence
- `examples/error-compliant-server.ts` — seller with error handling
