# Server Builder Quick Start

How to build an AdCP MCP server that passes `storyboard run`. Focuses on the non-obvious pitfalls.

## The Minimum Viable Server

Your server needs these tools to pass core + products + media_buy + reporting:

- `get_adcp_capabilities`
- `get_products`
- `create_media_buy`
- `get_media_buy_delivery`

## Pitfall 1: get_adcp_capabilities Response Shape

The field names are **not** what you'd guess.

Wrong:
```json
{
  "adcp_version": "3.0",
  "protocols": ["mcp"]
}
```

Right:
```json
{
  "adcp": {
    "major_versions": [3]
  },
  "supported_protocols": ["media_buy"],
  "media_buy": {
    "features": {
      "inline_creative_management": false,
      "property_list_filtering": false,
      "content_standards": false
    }
  }
}
```

Key details:
- `adcp.major_versions` is an array of integers, not a version string.
- `supported_protocols` lists **domain protocols** (media_buy, signals, governance, creative, sponsored_intelligence), not transport protocols (mcp, a2a).
- If you get this wrong, `parseCapabilitiesResponse` silently produces a "supports nothing" capabilities object. There is no error. Your server will appear to work but `storyboard run` will report cross-validation failures.

## Pitfall 2: Product Schema Required Fields

`get_products` must return products with all of these fields:

```json
{
  "product_id": "prod_001",
  "name": "Display Banner",
  "description": "Standard display ad unit.",
  "publisher_properties": [
    { "publisher_domain": "example.com", "selection_type": "all" }
  ],
  "channels": ["display"],
  "format_ids": [
    { "agent_url": "https://creatives.example.com", "id": "display_static", "width": 300, "height": 250 }
  ],
  "delivery_type": "non_guaranteed",
  "pricing_options": [
    {
      "pricing_option_id": "po_cpm",
      "pricing_model": "cpm",
      "fixed_price": 5.0,
      "currency": "USD",
      "min_spend_per_package": 500
    }
  ]
}
```

Missing any of `description`, `publisher_properties`, `format_ids`, or `delivery_type` will cause schema validation failures in the media_buy track even though the products track passes.

## Pitfall 3: Delivery Response Shape

`get_media_buy_delivery` must return `reporting_period` and `media_buy_deliveries`:

```json
{
  "reporting_period": {
    "start": "2026-03-18T00:00:00Z",
    "end": "2026-03-19T00:00:00Z"
  },
  "media_buy_deliveries": [
    {
      "media_buy_id": "mb_123",
      "status": "active",
      "totals": { "impressions": 1000, "spend": 5.0 },
      "by_package": []
    }
  ]
}
```

Both `reporting_period` and `media_buy_deliveries` are required. Each delivery needs `status` (valid values: `pending_activation`, `pending`, `active`, `paused`, `completed`, `rejected`, `canceled`, `failed`, `reporting_delayed`), `totals`, and `by_package`.

## Pitfall 4: Rate Limit State and Per-Request Servers

If you create a new `McpServer` per HTTP request (common with StreamableHTTP), module-scoped state resets on every request. Rate limit counters, media buy storage, and other state must live outside the server constructor.

```typescript
// Module-scoped state
const mediaBuys = new Map<string, MediaBuy>();
let requestCount = 0;

function createServer() {
  const server = new McpServer({ name: 'my-agent', version: '1.0.0' });
  // Tools reference module-scoped state, not instance state
  server.tool('create_media_buy', schema, (args) => {
    requestCount++;
    mediaBuys.set(id, buy);
    // ...
  });
  return server;
}
```

## Pitfall 5: create_media_buy Must Echo Back Packages

The response must include the full media buy object with packages array. Comply validates that the packages you sent are reflected in the response.

```json
{
  "media_buy": {
    "media_buy_id": "mb_123",
    "status": "pending",
    "packages": [
      {
        "buyer_ref": "pkg-test-123",
        "product_id": "prod_001",
        "budget": 1000,
        "pricing_option_id": "po_cpm",
        "start_time": "2026-03-20T00:00:00Z",
        "end_time": "2026-03-27T00:00:00Z"
      }
    ]
  }
}
```

## What Each Track Tests

| Track | Scenarios | What Passes |
|-------|-----------|-------------|
| Core (4) | health_check, discovery, capability_discovery, schema_compliance | Agent responds, lists tools, returns valid capabilities, schema fields correct |
| Products (3) | pricing_edge_cases, behavior_analysis, response_consistency | Products have valid pricing, behave consistently across calls |
| Media Buy (4) | create_media_buy, full_sales_flow, creative_inline, temporal_validation | Can create and retrieve buys, delivery works, dates validated |
| Reporting (1) | full_sales_flow (reused) | get_media_buy_delivery returns valid delivery data |
| Error Handling (3) | error_codes, error_structure, error_transport | Errors use AdCP error codes and structuredContent |

## Storyboard Quick Reference

```bash
# Run all tracks
npx @adcp/client storyboard run http://localhost:3456/mcp

# Run one track
npx @adcp/client storyboard run http://localhost:3456/mcp --track core

# JSON output for debugging
npx @adcp/client storyboard run http://localhost:3456/mcp --format json
```
