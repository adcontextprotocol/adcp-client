---
name: build-adcp-agent
description: Use when building any AdCP agent — seller, signals, creative, governance, or social platform. Guides through domain decisions, implementation, and storyboard validation.
---

# Build an AdCP Agent

## Overview

AdCP agents are MCP servers that implement advertising protocol tools. This skill guides you through building one — from domain decisions through a passing storyboard.

The loop: **understand the domain → ask the right questions → scaffold → run storyboard → fix failures → repeat until green.**

## Step 1: What Kind of Agent?

Ask the user. These are the main archetypes:

| Agent type | What it does | Key tools | Primary storyboard |
|-----------|-------------|-----------|-------------------|
| **Seller** | Sells ad inventory (publisher, SSP, retail media) | `get_products`, `create_media_buy` | `media_buy_seller` |
| **Signals** | Serves audience segments for targeting (data provider, CDP) | `get_signals`, `activate_signal` | `signal_marketplace` or `signal_owned` |
| **Creative** | Renders ad creatives from briefs | `build_creative`, `preview_creative` | `creative_lifecycle` |
| **Governance** | Validates campaigns against policies | `check_governance`, `sync_plans` | `campaign_governance_conditions` |
| **Social platform** | Manages accounts, audiences, creatives on social | `sync_accounts`, `sync_audiences`, `sync_creatives` | `social_platform` |

Once you know the type, follow the domain-specific section below, then jump to **Implementation** and **Validation**.

---

## Seller Agent

A seller agent receives briefs from buyers, returns products with pricing, accepts media buys, manages creatives, and reports delivery.

### Domain Decisions (ask the user)

**1. What kind of seller?**
- **Premium publisher** — guaranteed inventory, fixed pricing, IO approval (ESPN, NYT)
- **SSP / Exchange** — non-guaranteed, auction-based, instant activation
- **Retail media network** — both guaranteed and non-guaranteed, proposals, catalog-driven creative, conversion tracking

**2. Guaranteed or non-guaranteed?**
- **Guaranteed** — `delivery_type: "guaranteed"`, may require async approval (`submitted` → `pending_approval` → `confirmed`)
- **Non-guaranteed** — `delivery_type: "non_guaranteed"`, buyer sets `bid_price`, instant activation

**3. Products and pricing** — get specific inventory: names, channels (`display`, `olv`, `ctv`, `retail_media`), pricing model (`cpm`, `cpc`, auction with `floor_price`), `min_spend_per_package`

**4. Approval workflow** — instant confirmation, async approval (`registerAdcpTaskTool`), or human-in-the-loop (setup URL)

**5. Creative management** — standard (`list_creative_formats` + `sync_creatives`), catalog-driven (`sync_catalogs`), or none

### Tools and Required Response Shapes

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
taskToolResponse({
  media_buys: [{
    media_buy_id: string,   // required
    status: 'active' | 'pending_activation' | ...,  // required
    currency: 'USD',        // required
    packages: [{
      package_id: string,   // required
    }],
  }]
})
```

**`list_creative_formats`** — `ListCreativeFormatsRequestSchema.shape`
```
taskToolResponse({
  formats: [{
    format_id: { agent_url: string, id: string },  // required
    name: string,  // required
  }]
})
```

**`sync_creatives`** — `SyncCreativesRequestSchema.shape`
```
taskToolResponse({
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

### Storyboards

| Storyboard | Use case |
|-----------|----------|
| `media_buy_seller` | Full lifecycle — every seller should pass this |
| `media_buy_non_guaranteed` | Auction flow with bid adjustment |
| `media_buy_guaranteed_approval` | IO approval workflow |
| `media_buy_proposal_mode` | AI-generated proposals |
| `media_buy_catalog_creative` | Catalog sync + conversions |

---

## Signals Agent

A signals agent serves audience segments to buyers for campaign targeting.

### Domain Decisions (ask the user)

**1. Marketplace or owned?**
- **Marketplace** — aggregates third-party providers. `signal_type: "marketplace"`, `signal_id.source: "catalog"`, traces to `data_provider_domain`
- **Owned** — first-party data (retailer CDP, publisher contextual). `signal_type: "owned"`, `signal_id.source: "agent"`

**2. Segments** — names, definitions, `coverage_percentage` (5-30%), `value_type` (`binary`, `categorical`, `numeric`)

**3. Pricing** — `cpm` (`{ model: "cpm", cpm: 2.50 }`), `percent_of_media` (`{ model: "percent_of_media", percent: 15 }`), or `flat_fee`

**4. Activation** — platform destinations (DSP segment push) or agent destinations (key-value targeting)

### Tools and Required Response Shapes

**`get_signals`** — `GetSignalsRequestSchema.shape`

Every signal must include `signal_agent_segment_id` (the key buyers pass to `activate_signal`). Support `signal_spec` (natural language search) and `signal_ids` (exact lookup). Set `sandbox: true`.

**`activate_signal`** — `ActivateSignalRequestSchema.shape`

Look up by `signal_agent_segment_id`. Return deployments with `activation_key`. Handle `idempotency_key`.

### Storyboards

- `signal_marketplace` — discovery + activation for marketplace data
- `signal_owned` — owned data flow

---

## Creative Agent

A creative agent renders ad creatives from briefs or templates.

### Domain Decisions (ask the user)

**1. Generative or template?**
- **Generative** — AI-powered creative from natural language brief
- **Template** — format-based rendering from structured assets

**2. Formats** — what ad formats: display sizes, video lengths, social formats

**3. Preview** — render previews before final build? Single or batch?

### Tools to Implement

| Tool | Schema |
|------|--------|
| `get_adcp_capabilities` | `{}` |
| `list_creative_formats` | `ListCreativeFormatsRequestSchema` |
| `build_creative` | `BuildCreativeRequestSchema` |
| `preview_creative` | `PreviewCreativeRequestSchema` |

### Storyboards

- `creative_lifecycle` — format discovery → build → preview → sync
- `creative_template` — template-based rendering

---

## SDK Quick Reference

| SDK piece | Usage |
|-----------|-------|
| `serve(createAgent)` | Start HTTP server on `:3001/mcp` |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support |
| `server.tool(name, Schema.shape, handler)` | Register tool — `.shape` unwraps Zod for MCP SDK |
| `capabilitiesResponse(data)` | Build `get_adcp_capabilities` response |
| `productsResponse(data)` | Build `get_products` response |
| `mediaBuyResponse(data)` | Build `create_media_buy` response |
| `deliveryResponse(data)` | Build `get_media_buy_delivery` response |
| `taskToolResponse(data, summary)` | Build generic tool response |
| `adcpError(code, { message })` | Structured error (e.g., `BUDGET_TOO_LOW`, `PRODUCT_NOT_FOUND`) |
| `registerAdcpTaskTool(server, name, config, handler)` | Register async task-based tool |

Import everything from `@adcp/client`. Types from `@adcp/client` with `import type`.

## Implementation

1. Read `docs/guides/BUILD-AN-AGENT.md` for patterns
2. Single `.ts` file for a mock agent
3. Always register `get_adcp_capabilities` as the **first** tool with empty `{}` schema
4. Use `Schema.shape` (not `Schema`) when registering tools
5. Use response builders — never return raw JSON
6. Set `sandbox: true` on all mock/demo responses
7. Use `ServeContext` pattern: `function createAgent({ taskStore }: ServeContext)` and pass `taskStore` to `createTaskCapableServer`

## Validation

**After writing the agent, run the storyboard. Fix failures. Repeat.**

```bash
# Start the agent
npx tsx agent.ts

# In another terminal:
npx @adcp/client http://localhost:3001/mcp                              # discover tools
npx @adcp/client storyboard run http://localhost:3001/mcp <storyboard> --json  # run storyboard
npx @adcp/client comply http://localhost:3001/mcp                        # compliance check
```

Replace `<storyboard>` with the primary storyboard for your agent type (see tables above).

The storyboard output shows per-step pass/fail with validation details. Fix each failure:
- `response_schema` failure → your response doesn't match the Zod schema for that tool
- `field_present` failure → a required field is missing from your response
- MCP error → check tool registration (schema, name)

**Keep iterating until all steps pass.** Read the storyboard YAML (`storyboards/<id>.yaml`) to understand what each step sends and what it validates.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Pass `Schema` instead of `Schema.shape` | MCP SDK needs unwrapped Zod fields |
| Skip `get_adcp_capabilities` | Must be the first tool registered |
| Return raw JSON without response builders | LLM clients need the text content layer |
| Missing `brand`/`operator` in sync_accounts response | Echo them back from the request — they're required |
| sync_governance returns wrong shape | Must include `status: 'synced'` and `governance_agents` array per account |
| `sandbox: false` on mock data | Buyers may treat mock data as real |

## Reference

- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns and async tools
- `docs/llms.txt` — full protocol reference
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `storyboards/` — all storyboard definitions
- `examples/signals-agent.ts` — complete signals agent example
- `examples/error-compliant-server.ts` — seller with error handling
