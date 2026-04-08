---
name: build-signals-agent
description: Use when building an AdCP signals agent, creating an audience data server, or standing up a data provider agent that serves targeting segments to buyers.
---

# Build a Signals Agent

## Overview

A signals agent serves audience segments to buyers for campaign targeting. Two tools: `get_signals` (discovery) and `activate_signal` (push to DSPs or sales agents). The business model — marketplace vs owned data — shapes every implementation decision. Determine that first.

## When to Use

- User wants to build an agent that serves audience/targeting data
- User mentions signals, segments, audiences, data provider, or CDP in the context of AdCP
- User references `get_signals`, `activate_signal`, or the signals protocol

**Not this skill:**
- Selling ad inventory (products, packages, media buys) → that's a seller agent
- Rendering creatives from briefs → that's a creative agent
- Building a client that *calls* a signals agent → see `docs/getting-started.md`

## Before Writing Code

Determine these four things. Ask the user — don't guess.

### 1. Marketplace or Owned?

These are fundamentally different businesses.

**Marketplace** — aggregates third-party data providers (LiveRamp, Oracle Data Cloud, Lotame). Buyers verify provenance independently via the provider's `adagents.json`. Each signal has `signal_type: "marketplace"` and traces to a `data_provider_domain`. You need authorization from each provider.

**Owned** — first-party data (retailer CDP, publisher contextual data, CRM). Buyers trust your agent directly — no external verification. `signal_type: "owned"`, `signal_id.source: "agent"`. Richer value types are common here (loyalty tiers, engagement scores, purchase frequency).

### 2. What Segments?

Get specifics: names, definitions, what each represents. Push for 3-5 segments with variety. Each needs:
- Clear behavioral/demographic definition
- Realistic `coverage_percentage` (typically 5-30%)
- Value type: `binary` (in/out), `categorical` (tier levels — define the categories), or `numeric` (score range — define min/max)

### 3. Pricing

At least one pricing option per signal:
- `cpm` — `{ model: "cpm", cpm: 2.50, currency: "USD" }`
- `percent_of_media` — `{ model: "percent_of_media", percent: 15, currency: "USD" }`, optional `max_cpm` ceiling
- `flat_fee` — `{ model: "flat_fee", amount: 5000, period: "monthly", currency: "USD" }`

### 4. Activation Destinations

If implementing `activate_signal`:
- **Platform** (DSP): async, returns `activation_key: { type: "segment_id", segment_id: "..." }`
- **Agent** (sales agent): typically sync, returns `activation_key: { type: "key_value", key: "...", value: "..." }`

## Quick Reference

| SDK piece | Usage |
|-----------|-------|
| `serve(createAgent)` | Start HTTP server on `:3001/mcp` |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support |
| `server.tool(name, desc, Schema.shape, handler)` | Register tool — note `.shape` unwrap |
| `taskToolResponse(data, summary)` | Build correct MCP response |
| `adcpError(code, { message })` | Structured error (`SIGNAL_NOT_FOUND`, `INVALID_DESTINATION`) |
| `GetSignalsRequestSchema.shape` | Zod schema for get_signals input |
| `ActivateSignalRequestSchema.shape` | Zod schema for activate_signal input |
| `type Signal = GetSignalsResponse['signals'][number]` | Type for a single signal object |

Import everything from `@adcp/client`. Types from `@adcp/client` with `import type`.

## Implementation

Scaffold from `docs/guides/BUILD-AN-AGENT.md`. Single file for a mock agent.

### get_signals

Two discovery modes — support both:
1. `signal_spec` — natural language. Match against segment names and descriptions.
2. `signal_ids` — exact lookup by `{ source, data_provider_domain, id }`.

Plus filtering via `filters.catalog_types`, `filters.max_cpm`, `filters.min_coverage_percentage`, and `max_results`.

Every returned signal must include `signal_agent_segment_id` — the key buyers pass to `activate_signal`.

Set `sandbox: true` for mock/demo data.

### activate_signal

Look up by `signal_agent_segment_id`. Validate `pricing_option_id`. Return deployments with `is_live` status and `activation_key`. Handle `idempotency_key` for retry safety. Support `action: "deactivate"`.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Pass `Schema` instead of `Schema.shape` | MCP SDK needs unwrapped Zod fields |
| Missing `signal_agent_segment_id` on signals | Buyers can't activate without it |
| Skip `taskToolResponse()`, return raw JSON | LLM clients can't read response without text layer |
| `is_live: true` in get_signals deployments | Signals aren't live until activate_signal |
| No `sandbox: true` on mock data | Buyers may treat mock data as real |

## Testing

```bash
npx tsx agent.ts
npx @adcp/client http://localhost:3001/mcp                    # discover tools
npx @adcp/client http://localhost:3001/mcp get_signals '{}'   # all segments
npx @adcp/client comply http://localhost:3001/mcp             # compliance
```

## Reference

- `examples/signals-agent.ts` — complete runnable example
- `storyboards/signal_marketplace.yaml` — buyer call sequences for marketplace agent
- `storyboards/signal_owned.yaml` — call sequences for owned data agent
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/llms.txt` — full protocol reference
