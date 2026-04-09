---
name: build-seller-agent
description: Use when building an AdCP seller agent — a publisher, SSP, or retail media network that sells advertising inventory to buyer agents.
---

# Build a Seller Agent

## Overview

A seller agent receives briefs from buyers, returns available products with pricing, accepts media buys, manages creative assets, and reports delivery. The business model — what you sell, how you price it, and whether humans approve deals — shapes every implementation decision. Determine that first.

## When to Use

- User wants to build an agent that sells ad inventory
- User mentions publisher, SSP, retail media, or media network in the context of AdCP
- User references `get_products`, `create_media_buy`, or the media buy protocol

**Not this skill:**
- Buying ad inventory → that's a buyer/DSP agent (see `docs/getting-started.md`)
- Serving audience segments → that's a signals agent (see `skills/build-signals-agent/`)
- Rendering creatives from briefs → that's a creative agent

## Before Writing Code

Determine these five things. Ask the user — don't guess.

### 1. What Kind of Seller?

These have different product catalogs, pricing, and approval workflows.

**Premium publisher** — sells guaranteed inventory on owned properties (e.g., ESPN pre-roll, NYT homepage takeover). Products have fixed pricing, delivery SLAs, and usually require IO approval before going live.

**SSP / Exchange** — sells non-guaranteed inventory via auction. Products have floor prices, buyers set bids, delivery is best-effort. Buys activate immediately, no approval step.

**Retail media network** — sells on-site placements tied to product catalogs (e.g., sponsored products on a retailer site). Often supports both guaranteed and non-guaranteed, generates proposals from briefs, and tracks conversions back to catalog items.

### 2. Guaranteed or Non-Guaranteed?

This is the most consequential decision. It determines approval workflows, status returns, and delivery semantics.

**Guaranteed** — inventory is reserved. Seller commits to impressions/reach. Requires `delivery_type: "guaranteed"` on products. Media buys may go through approval (`submitted` → `pending_approval` → `confirmed`). Delivery metrics include pacing against committed volume.

**Non-guaranteed** — auction-based, best-effort. `delivery_type: "non_guaranteed"`. Buyer sets `bid_price`. Buys activate immediately (`completed`). Delivery metrics include win rate and clearing price.

Many sellers support both — different products can have different delivery types.

### 3. Products and Pricing

Get specifics about the inventory. Each product needs:
- Name and description (what the buyer is purchasing)
- Channel: `display`, `olv`, `ctv`, `social`, `retail_media`, `dooh`, etc.
- Creative format requirements (what assets the buyer must provide)
- At least one pricing option with model and price

Pricing models:
- `cpm` — `{ pricing_model: "cpm", fixed_price: 12.00, currency: "USD" }`
- `cpc` — `{ pricing_model: "cpc", fixed_price: 1.50, currency: "USD" }`
- Auction — `{ pricing_model: "cpm", floor_price: 5.00, currency: "USD" }` (buyer bids above floor)

Each pricing option can set `min_spend_per_package` to enforce minimum budgets.

### 4. Approval Workflow

For guaranteed buys, choose one:
- **Instant confirmation** — `create_media_buy` returns `completed` with confirmed status. Simplest.
- **Async approval** — returns `submitted`, then buyer polls `get_media_buys` until status changes. Use `registerAdcpTaskTool` for this pattern.
- **Human-in-the-loop** — returns `input-required` with a setup URL where a human reviews and signs the IO. Most realistic for premium publishers.

Non-guaranteed buys are always instant confirmation.

### 5. Creative Management

Choose the creative workflow:
- **Standard** — buyer calls `list_creative_formats` to discover specs, then `sync_creatives` to upload assets. Seller validates and returns per-creative status (`accepted`, `pending_review`, `rejected`).
- **Catalog-driven** — buyer syncs a product catalog via `sync_catalogs`. Seller renders dynamic ads from the feed. Common for retail media.
- **None** — seller handles creative separately (out-of-band). Omit creative tools.

## Quick Reference

| SDK piece | Usage |
|-----------|-------|
| `serve(createAgent)` | Start HTTP server on `:3001/mcp` |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support |
| `server.tool(name, Schema.shape, handler)` | Register tool — note `.shape` unwrap |
| `capabilitiesResponse(data)` | Build `get_adcp_capabilities` response |
| `productsResponse(data)` | Build `get_products` response |
| `mediaBuyResponse(data)` | Build `create_media_buy` response |
| `taskToolResponse(data, summary)` | Build generic MCP response |
| `adcpError(code, { message })` | Structured error (e.g., `BUDGET_TOO_LOW`, `PRODUCT_NOT_FOUND`) |

Import everything from `@adcp/client`. Types from `@adcp/client` with `import type`.

Schemas: `GetProductsRequestSchema`, `CreateMediaBuyRequestSchema`, `GetMediaBuysRequestSchema`, `GetMediaBuyDeliveryRequestSchema`, `SyncAccountsRequestSchema`, `SyncGovernanceRequestSchema`, `ListCreativeFormatsRequestSchema`, `SyncCreativesRequestSchema`.

## Implementation

Scaffold from `docs/guides/BUILD-AN-AGENT.md`. Single file for a mock agent.

### Required: get_adcp_capabilities

Always register this first. Empty schema `{}`. Return `supported_protocols: ["media_buy"]` and declare features.

```
server.tool('get_adcp_capabilities', {}, async () => {
  return capabilitiesResponse({
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
  });
});
```

### Required: get_products

Two modes — support both:
1. `buying_mode: "brief"` — natural language discovery. Match brief against your product catalog.
2. `buying_mode: "refine"` — iterative refinement. Apply constraints from `refine[]` to previous results.

Every product must include `product_id`, `delivery_type`, and at least one `pricing_options` entry.

Set `sandbox: true` for mock/demo data.

### Required: create_media_buy

Validate packages against your product catalog. Check `product_id` exists, `pricing_option_id` is valid, `budget` meets minimums. Return structured errors via `adcpError` for validation failures.

For sync confirmation: use `mediaBuyResponse({ media_buy_id, packages })`.
For async: use `registerAdcpTaskTool` and return task status.

### Recommended: sync_accounts

Establish buyer-seller account relationship. Return `account_id`, `action` (`created`/`updated`), `status` (`active` or `pending_approval`).

### Recommended: get_media_buys

Return current state of media buys by ID. Include `status`, `currency`, `packages`, and `valid_actions`.

### Recommended: list_creative_formats + sync_creatives

`list_creative_formats` — return format specs with `format_id` (must include `agent_url` and `id`), `name`.

`sync_creatives` — validate uploaded assets, return per-creative `action` (`created`/`updated`) and status.

### Recommended: get_media_buy_delivery

Return delivery metrics: `reporting_period`, per-buy `totals` (impressions, spend), and optionally `by_package` breakdowns.

### Optional: sync_governance

Accept governance agent registrations. Return `status: "synced"` per account. Call registered governance agents during `create_media_buy` to validate buys.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Pass `Schema` instead of `Schema.shape` | MCP SDK needs unwrapped Zod fields |
| Skip `get_adcp_capabilities` | Must be the first tool registered — required for protocol discovery |
| Return raw JSON without `taskToolResponse()` / response builders | LLM clients can't read response without the text content layer |
| Missing `product_id` or `pricing_options` on products | Buyers can't select products for media buys without these |
| Return `sandbox: false` on mock data | Buyers may treat mock data as real inventory |
| Hardcode `confirmed` status when async approval is needed | Use task status (`working`, `submitted`, `input-required`) for async flows |

## Testing

```bash
npx tsx agent.ts
npx @adcp/client http://localhost:3001/mcp                    # discover tools
npx @adcp/client comply http://localhost:3001/mcp             # compliance check
npx @adcp/client storyboard run http://localhost:3001/mcp media_buy_seller --json  # full storyboard
```

The `media_buy_seller` storyboard tests the complete lifecycle: account setup → governance → product discovery → refinement → media buy → creative sync → delivery monitoring.

## Storyboards

| Storyboard | Tests | When to use |
|-----------|-------|-------------|
| `media_buy_seller` | Full lifecycle (9 steps) | Every seller agent |
| `media_buy_non_guaranteed` | Auction flow, bid adjustment | SSP/exchange agents |
| `media_buy_guaranteed_approval` | IO approval workflow | Premium publishers |
| `media_buy_proposal_mode` | AI-generated proposals | Retail media, full-service |
| `media_buy_catalog_creative` | Catalog sync + conversions | Retail media with dynamic ads |

## Reference

- `examples/error-compliant-server.ts` — working seller with error handling
- `storyboards/media_buy_seller.yaml` — full buyer interaction sequence
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns and async tools
- `docs/llms.txt` — full protocol reference
- `docs/TYPE-SUMMARY.md` — curated type signatures
