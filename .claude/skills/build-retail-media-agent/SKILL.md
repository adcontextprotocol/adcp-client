---
name: build-retail-media-agent
description: Use when building an AdCP retail media network agent — a platform that sells on-site placements, supports product catalogs, tracks conversions, and reports performance.
---

# Build a Retail Media Agent

## Overview

A retail media agent sells advertising on a retailer's properties (sponsored products, homepage banners, search results). It extends the standard seller with catalog sync, event tracking, and performance feedback. Buyers sync product catalogs, the platform renders dynamic ads from the feed, and conversion data flows back for optimization.

## When to Use

- User wants to build a retail media network, commerce media platform, or sponsored products agent
- User mentions catalogs, product feeds, conversion tracking, or performance feedback
- User references `sync_catalogs`, `log_event`, or `provide_performance_feedback`

**Not this skill:**

- Standard seller without catalogs → `skills/build-seller-agent/`
- Generative seller (AI creative from briefs) → `skills/build-generative-seller-agent/`
- Signals/audience data → `skills/build-signals-agent/`

## Before Writing Code

Same domain decisions as the seller skill, plus:

### 1. Products and pricing

Same as seller. Each product needs: `product_id`, `name`, `description`, `publisher_properties`, `format_ids`, `delivery_type`, `pricing_options`. See [`docs/TYPE-SUMMARY.md`](../../docs/TYPE-SUMMARY.md) for full field details.

### 2. Catalog support

What product catalogs does the platform accept?

- Feed format: JSON, CSV, XML
- What fields: product_id, title, price, image_url, category
- How does the catalog connect to ad rendering?

### 3. Event tracking

What conversion events does the platform track?

- Purchase, add_to_cart, page_view, search
- How are events attributed to catalog items?

### 4. Performance feedback

Does the buyer send performance metrics back for optimization?

## Tools and Required Response Shapes

All standard seller tools apply (see `skills/build-seller-agent/SKILL.md`). The additional tools:

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
    account_id: string,
    brand: { domain: string },
    operator: string,
    action: 'created' | 'updated',
    status: 'active' | 'pending_approval',
  }]
})
```

**`get_products`** — `GetProductsRequestSchema.shape`

```
productsResponse({ products: Product[], sandbox: true })
```

**`create_media_buy`** — `CreateMediaBuyRequestSchema.shape`

```
mediaBuyResponse({
  media_buy_id: string,
  packages: [{ package_id, product_id, pricing_option_id, budget }],
})
```

**`list_creative_formats`** — `ListCreativeFormatsRequestSchema.shape`

```
listCreativeFormatsResponse({
  formats: [{
    format_id: { agent_url: string, id: string },
    name: string,
  }]
})
```

**`sync_catalogs`** — `SyncCatalogsRequestSchema.shape`

Accept product catalog feeds. Return per-catalog status with item counts.

```
taskToolResponse({
  catalogs: [{
    catalog_id: string,        // required — echo from request
    action: 'created' | 'updated',  // required
    item_count: number,        // total items in catalog
    items_approved: number,    // items that passed validation
  }],
  sandbox: true,
})
```

**`sync_event_sources`** — `SyncEventSourcesRequestSchema.shape`

Register event tracking integrations.

```
taskToolResponse({
  event_sources: [{
    event_source_id: string,   // required — echo from request
    action: 'created' | 'updated',  // required
  }],
  sandbox: true,
})
```

**`log_event`** — `LogEventRequestSchema.shape`

Accept conversion events.

```
taskToolResponse({
  events_received: number,     // required — how many events in the request
  events_processed: number,    // required — how many were successfully processed
  sandbox: true,
})
```

**`provide_performance_feedback`** — `ProvidePerformanceFeedbackRequestSchema.shape`

Accept performance metrics from the buyer.

```
performanceFeedbackResponse({
  success: true,
  sandbox: true,
})
```

**`get_media_buy_delivery`** — `GetMediaBuyDeliveryRequestSchema.shape`

```
deliveryResponse({
  reporting_period: { start: string, end: string },
  media_buy_deliveries: [{
    media_buy_id: string,
    status: 'active',
    totals: { impressions: number, spend: number },
    by_package: [],
  }]
})
```

## Compliance Testing (Optional)

Add `registerTestController` so the comply framework can deterministically test your state machines. One function call — the SDK handles request parsing, status validation, and response formatting.

```
import { registerTestController, TestControllerError } from '@adcp/client';
import type { TestControllerStore } from '@adcp/client';

const store: TestControllerStore = {
  async forceAccountStatus(accountId, status) {
    const prev = accounts.get(accountId);
    if (!prev) throw new TestControllerError('NOT_FOUND', `Account ${accountId} not found`);
    accounts.set(accountId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async forceMediaBuyStatus(mediaBuyId, status) { /* same pattern */ },
  async forceCreativeStatus(creativeId, status) { /* same pattern */ },
  // simulateDelivery, simulateBudgetSpend — implement as needed
};

registerTestController(server, store);
```

Declare `compliance_testing` in `supported_protocols` in your `get_adcp_capabilities` response. Only implement the store methods for scenarios your agent supports — unimplemented methods are excluded from `list_scenarios` automatically.

Validate with: `adcp storyboard run <agent> deterministic_testing --json`

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `serve(createAgent)`                                    | Start HTTP server on `:3001/mcp`                                    |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support                                 |
| `server.tool(name, Schema.shape, handler)`              | Register tool — `.shape` unwraps Zod                                |
| `capabilitiesResponse(data)`                            | Build `get_adcp_capabilities` response                              |
| `productsResponse(data)`                                | Build `get_products` response                                       |
| `mediaBuyResponse(data)`                                | Build `create_media_buy` response                                   |
| `deliveryResponse(data)`                                | Build `get_media_buy_delivery` response                             |
| `listCreativeFormatsResponse(data)`                     | Build `list_creative_formats` response                              |
| `performanceFeedbackResponse(data)`                     | Build `provide_performance_feedback` response                       |
| `taskToolResponse(data, summary)`                       | Build generic tool response (for tools without a dedicated builder) |
| `adcpError(code, { message })`                          | Structured error                                                    |
| `registerTestController(server, store)`                 | Add `comply_test_controller` for deterministic testing              |

Schemas: `GetProductsRequestSchema`, `CreateMediaBuyRequestSchema`, `GetMediaBuyDeliveryRequestSchema`, `SyncAccountsRequestSchema`, `ListCreativeFormatsRequestSchema`, `SyncCatalogsRequestSchema`, `SyncEventSourcesRequestSchema`, `LogEventRequestSchema`, `ProvidePerformanceFeedbackRequestSchema`.

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

1. Single `.ts` file — all tools in one file
2. Always register `get_adcp_capabilities` as the **first** tool with empty `{}` schema
3. Use `Schema.shape` (not `Schema`) when registering tools
4. Use response builders — never return raw JSON
5. Set `sandbox: true` on all mock/demo responses
6. Use `ServeContext` pattern: `function createAgent({ taskStore }: ServeContext)`

The skill contains everything you need. Do not read additional docs before writing code.

## Validation

**After writing the agent, validate it. Fix failures. Repeat.**

```bash
npx tsx agent.ts &
npx @adcp/client@latest storyboard run http://localhost:3001/mcp media_buy_catalog_creative --json
```

**Keep iterating until all steps pass.**

## Common Mistakes

| Mistake                                                  | Fix                                            |
| -------------------------------------------------------- | ---------------------------------------------- |
| Skip `get_adcp_capabilities`                             | Must be the first tool registered              |
| Pass `Schema` instead of `Schema.shape`                  | MCP SDK needs unwrapped Zod fields             |
| sync_catalogs missing `item_count` / `items_approved`    | Optional but recommended for catalog validation results |
| log_event missing `events_received` / `events_processed` | Required counters                              |
| `sandbox: false` on mock data                            | Buyers may treat mock data as real             |

## Reference

- `skills/build-seller-agent/SKILL.md` — base seller skill (retail media extends this)
- `storyboards/media_buy_catalog_creative.yaml` — full catalog creative storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
