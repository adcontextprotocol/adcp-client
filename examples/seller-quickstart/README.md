# Seller Agent Quickstart

A copy-paste MCP server scaffold for building an AdCP seller agent (publisher, SSP, retail media network).

## Run it

```bash
npx tsx examples/seller-quickstart/server.ts
```

The server starts on `http://localhost:3000/mcp`.

## Verify with the storyboard runner

```bash
npx @adcp/client storyboard run http://localhost:3000/mcp media_buy_seller --json
```

This runs the full media buy seller storyboard: account setup, product discovery, media buy creation, creative sync, and delivery reporting.

## Explore the tools

```bash
# Discover all tools
npx @adcp/client http://localhost:3000/mcp

# Send a product brief
npx @adcp/client http://localhost:3000/mcp get_products '{"buying_mode":"brief","brief":"premium video"}'

# Create a media buy
npx @adcp/client http://localhost:3000/mcp create_media_buy '{
  "account":{"brand":{"domain":"example.com"},"operator":"agency.com"},
  "brand":{"domain":"example.com"},
  "start_time":"2026-05-01T00:00:00Z",
  "end_time":"2026-06-30T23:59:59Z",
  "packages":[{"product_id":"sports_preroll_q2","budget":10000,"pricing_option_id":"cpm_guaranteed"}]
}'
```

## What to do next

Every handler in `server.ts` returns hardcoded data. Replace each one with your real logic:

1. **`sync_accounts`** — Provision accounts in your system, run credit checks
2. **`get_products`** — Query your inventory catalog, apply targeting, generate forecasts
3. **`create_media_buy`** — Validate budgets, reserve inventory, trigger approval workflows
4. **`get_media_buys`** — Return live status from your order management system
5. **`list_creative_formats`** — Return your actual creative specs and asset requirements
6. **`sync_creatives`** — Validate and transcode uploaded assets
7. **`get_media_buy_delivery`** — Aggregate real reporting data (impressions, spend, pacing)

See [`docs/guides/BUILD-AN-AGENT.md`](../../docs/guides/BUILD-AN-AGENT.md) for async patterns, error handling, and governance integration.
