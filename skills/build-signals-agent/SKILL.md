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

- Selling ad inventory (products, packages, media buys) → `skills/build-seller-agent/`
- Rendering creatives from briefs → that's a creative agent
- Building a client that _calls_ a signals agent → see `docs/getting-started.md`

## Before Writing Code

Determine these four things. Ask the user — don't guess.

### 1. Marketplace or Owned?

These are fundamentally different businesses.

**Marketplace** — aggregates third-party data providers (LiveRamp, Oracle Data Cloud, Lotame). Each signal traces to a `data_provider_domain` that buyers can verify via `adagents.json`. `signal_type: "marketplace"`, `signal_id.source: "catalog"`.

**Owned** — first-party data (retailer CDP, publisher contextual, CRM). Buyers trust your agent directly. `signal_type: "owned"` or `"custom"`, `signal_id.source: "agent"`.

### 2. What Segments?

Get specifics: names, definitions, what each represents. Push for 3-5 segments with variety. Each needs:

- Clear behavioral/demographic definition
- Realistic `coverage_percentage` (typically 5-30%)
- Value type: `binary` (in/out), `categorical` (tier levels — define the categories), or `numeric` (score range — define min/max)

### 3. Pricing

At least one pricing option per signal. Signals use `VendorPricingOption` (field: `model`), distinct from product `PricingOption` (field: `pricing_model`).

- `cpm` — `{ pricing_option_id: "po_cpm", model: "cpm", cpm: 2.50, currency: "USD" }`
- `percent_of_media` — `{ pricing_option_id: "po_pom", model: "percent_of_media", percent: 15, currency: "USD" }`
- `flat_fee` — `{ pricing_option_id: "po_flat", model: "flat_fee", amount: 5000, period: "monthly", currency: "USD" }`

### 4. Activation Destinations

If implementing `activate_signal`:

- **Platform** (DSP): `type: "platform"`, returns `activation_key: { type: "segment_id", segment_id: "..." }`
- **Agent** (sales agent): `type: "agent"`, returns `activation_key: { type: "key_value", key: "...", value: "..." }`

## Tools and Required Response Shapes

**`get_adcp_capabilities`** — register first, empty `{}` schema

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['signals'],
})
```

**`get_signals`** — `GetSignalsRequestSchema.shape`

Two discovery modes — support both:

1. `signal_spec` — natural language. Match against segment names and descriptions.
2. `signal_ids` — exact lookup by `{ source, data_provider_domain, id }` or `{ source, agent_url, id }`.

Plus filtering via `filters.catalog_types`, `filters.max_cpm`, `filters.min_coverage_percentage`, and `max_results`.

```
getSignalsResponse({
  signals: [{
    signal_agent_segment_id: string,  // required - key for activate_signal
    name: string,                     // required
    description: string,              // required
    signal_type: 'marketplace' | 'owned' | 'custom',  // required
    data_provider: string,            // required - your company name
    coverage_percentage: number,      // required - 0 to 100
    deployments: [],                  // required - empty array (not live until activated)
    pricing_options: [{               // required - at least one
      pricing_option_id: string,      // required
      model: 'cpm',                   // required - discriminator
      cpm: number,                    // required for cpm model
      currency: 'USD',               // required
    }],
    // signal_id is critical — shape depends on marketplace vs owned:
    signal_id: {
      source: 'catalog',             // marketplace
      data_provider_domain: string,  // marketplace — domain for provenance verification
      id: string,                    // unique segment ID
    },
    // OR for owned:
    signal_id: {
      source: 'agent',              // owned
      agent_url: string,            // your agent URL
      id: string,
    },
    value_type: 'binary' | 'categorical' | 'numeric',  // optional but recommended
  }],
  sandbox: true,  // for mock data
})
```

**`activate_signal`** — `ActivateSignalRequestSchema.shape`

Look up by `signal_agent_segment_id`. Validate `pricing_option_id`. Return deployments matching the requested destinations.

```
activateSignalResponse({
  deployments: [{
    // Match the destination type from the request:
    type: 'platform',              // for platform destinations
    platform: string,              // echo from request destination
    account: string | null,        // echo from request
    is_live: true,                 // signal is now active
    activation_key: {
      type: 'segment_id',
      segment_id: string,          // platform-specific segment ID
    },
  }],
  // OR for agent destinations:
  deployments: [{
    type: 'agent',
    agent_url: string,
    is_live: true,
    activation_key: {
      type: 'key_value',
      key: string,
      value: string,
    },
  }],
  sandbox: true,
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
  context,  // echo it back unchanged
});
```

Do not modify, inspect, or omit the context — treat it as opaque. If the request has no context, omit it from the response.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `activate_signal`.

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `serve(createAgent)`                                    | Start HTTP server on `:3001/mcp`                                    |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support                                 |
| `server.tool(name, Schema.shape, handler)`              | Register tool — `.shape` unwraps Zod                                |
| `capabilitiesResponse(data)`                            | Build `get_adcp_capabilities` response                              |
| `getSignalsResponse(data)`                              | Build `get_signals` response                                        |
| `activateSignalResponse(data)`                          | Build `activate_signal` response                                    |
| `taskToolResponse(data, summary)`                       | Build generic tool response (for tools without a dedicated builder) |
| `adcpError(code, { message })`                          | Structured error (`SIGNAL_NOT_FOUND`, `INVALID_DESTINATION`)        |
| `GetSignalsRequestSchema.shape`                         | Zod schema for get_signals input                                    |
| `ActivateSignalRequestSchema.shape`                     | Zod schema for activate_signal input                                |
| `type Signal = GetSignalsResponse['signals'][number]`   | Type for a single signal object                                     |

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
4. Set `sandbox: true` for mock/demo data
5. Use `ServeContext` pattern: `function createAgent({ taskStore }: ServeContext)`

The skill contains everything you need. Do not read additional docs before writing code.

## Validation

**After writing the agent, validate it. Fix failures. Repeat.**

**Full validation** (if you can bind ports):

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp signal_owned --json       # for owned data
npx @adcp/client storyboard run http://localhost:3001/mcp signal_marketplace --json  # for marketplace
```

**Sandbox validation** (if ports are blocked):

```bash
npx tsc --noEmit agent.ts
```

**Keep iterating until all steps pass.**

## Common Mistakes

| Mistake                                      | Fix                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Pass `Schema` instead of `Schema.shape`      | MCP SDK needs unwrapped Zod fields                                                                          |
| Skip `get_adcp_capabilities`                 | Must be the first tool registered                                                                           |
| Missing `signal_agent_segment_id` on signals | Buyers can't activate without it                                                                            |
| Wrong `signal_id` shape                      | Marketplace: `{ source: "catalog", data_provider_domain, id }`. Owned: `{ source: "agent", agent_url, id }` |
| Missing `data_provider` field                | Required on every signal — your company/brand name                                                          |
| Empty `pricing_options` array                | Must have at least one pricing option per signal                                                            |
| `is_live: true` in get_signals deployments   | Signals aren't live until `activate_signal` — use empty `deployments: []`                                   |
| Activation doesn't match destination type    | If request has `type: "platform"`, deployment must be `type: "platform"`                                    |
| `sandbox: false` on mock data                | Buyers may treat mock data as real                                                                          |
| Dropping `context` from responses              | Echo `args.context` back unchanged in every response — buyers use it for correlation |

## Reference

- `examples/signals-agent.ts` — complete runnable example
- `storyboards/signal_marketplace.yaml` — buyer call sequences for marketplace agent
- `storyboards/signal_owned.yaml` — call sequences for owned data agent
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
