---
name: build-brand-rights-agent
description: Use when building an AdCP brand rights agent — a platform that manages brand identity, licenses usage rights, and approves generated creatives.
---

# Build a Brand Rights Agent

## Overview

A brand rights agent represents a brand's identity and licensing. Buyers discover the brand, browse available rights (image usage, logo placement, AI generation), acquire licenses, and submit generated creatives for approval. The agent enforces brand guidelines.

## When to Use

- User wants to build an agent that manages brand identity and licensing
- User mentions brand rights, brand guidelines, creative approval, or licensing
- User references `get_brand_identity`, `get_rights`, `acquire_rights`, or `creative_approval`

**Not this skill:**

- Selling ad inventory → `skills/build-seller-agent/`
- Managing creative formats/library → `skills/build-creative-agent/`
- Evaluating media buys → `skills/build-governance-agent/`

## Before Writing Code

### 1. What Brand?

Define the brand this agent represents:
- Brand name, domain, logo URL
- Brand guidelines URL
- What languages/markets the brand operates in

### 2. What Rights Are Available?

Define licensable rights:
- **Image usage** — use brand images in digital ads
- **AI generation** — generate new creatives using brand assets
- **Logo placement** — use brand logo in ads
- **Co-branding** — combine with other brands

Each right needs pricing (flat fee, CPM, etc.) and terms (duration, auto-renew).

### 3. Approval Criteria

How are generated creatives reviewed?
- **Auto-approve** — passes basic checks, instantly approved
- **Guidelines check** — validate against brand standards
- **Human review** — queue for manual review

## Tools and Required Response Shapes

**`get_adcp_capabilities`** — register first, empty `{}` schema

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['brand'],
})
```

**`get_brand_identity`** — `{}` schema (no generated schema)

Return brand metadata. Response must include `brand_id` and `names` array.

```
taskToolResponse({
  brand_id: string,             // required
  names: [{                     // required — at least one
    name: string,
    language: 'en',
  }],
  logos: [{
    url: string,
    format: 'png' | 'svg',
  }],
  guidelines_url: string,
})
```

**`get_rights`** — `{}` schema (no generated schema)

Return available rights for the brand. Each right must have `rights_id`.

```
taskToolResponse({
  rights: [{
    rights_id: string,          // required
    name: string,
    description: string,
    uses: string[],             // e.g., ['ai_generated_image', 'digital_display']
    pricing_options: [{
      pricing_option_id: string,
      pricing_model: 'flat_rate',
      currency: 'USD',
      fixed_price: number,
    }],
    terms: {
      duration: '30d',
      auto_renew: boolean,
    },
  }],
})
```

**`acquire_rights`** — `{}` schema (no generated schema)

Acquire a license for a right. Response must include `rights_id` and `status`.

```
taskToolResponse({
  rights_id: string,            // required — echo from request
  rights_grant_id: string,      // unique grant identifier
  status: 'active',             // required
})
```

**`update_rights`** — `{}` schema (no generated schema)

Update an existing rights grant. Response must include `rights_id`.

```
taskToolResponse({
  rights_id: string,            // required
  rights_grant_id: string,
  status: 'active',
})
```

**`creative_approval`** — `{}` schema (no generated schema)

Submit a generated creative for brand approval. Response must include `decision`.

```
taskToolResponse({
  decision: 'approved' | 'rejected' | 'review',  // required
  rights_grant_id: string,
  creative_id: string,
  feedback: string,             // approval notes or rejection reason
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

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `createAdcpServer({ name, capabilities })`            | Create server with auto-generated `get_adcp_capabilities`           |
| `serve(() => { const server = createAdcpServer(...); ... return server; })` | Start HTTP server on `:3001/mcp` |
| `server.tool(name, {}, handler)`                        | Register brand rights tools on the returned server                  |
| `taskToolResponse(data, summary)`                       | Build tool response (used for all brand rights tools)               |
| `adcpError(code, { message })`                          | Structured error                                                    |

Brand rights tools do not have a domain group in `createAdcpServer` yet. Use `createAdcpServer` for server setup and capabilities, then register brand rights tools with `server.tool()` on the returned server. All brand rights tools use `{}` for input schemas.

Import: `import { createAdcpServer, serve, taskToolResponse, adcpError } from '@adcp/client';`

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

1. Single `.ts` file — use `createAdcpServer` for server setup, then register brand tools with `server.tool()`
2. Do not register `get_adcp_capabilities` — pass `capabilities: { ... }` to `createAdcpServer` to declare the `brand` protocol
3. All brand rights tools use `{}` as input schema
4. Use `taskToolResponse()` to wrap handler responses (brand tools are not auto-wrapped by domain groups)

```typescript
import { createAdcpServer, serve, taskToolResponse } from '@adcp/client';

serve(() => {
  const server = createAdcpServer({
    name: 'Brand Rights Agent',
    version: '1.0.0',
    capabilities: {
      major_versions: [3],
    },
  });

  server.tool('get_brand_identity', {}, async () => {
    return taskToolResponse({
      brand_id: 'brand_acme',
      names: [{ name: 'Acme Corp', language: 'en' }],
      guidelines_url: 'https://acme.com/guidelines',
    });
  });

  server.tool('acquire_rights', {}, async (args) => {
    return taskToolResponse({
      rights_id: args.rights_id,
      rights_grant_id: `grant_${Date.now()}`,
      status: 'active',
    });
  });

  // ... other brand rights tools

  return server;
});
```

The skill contains everything you need. Do not read additional docs before writing code.

## Validation

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp brand_rights --json
```

**Keep iterating until all steps pass.**

## Common Mistakes

| Mistake                                          | Fix                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Manually registering `get_adcp_capabilities`     | Pass `capabilities` to `createAdcpServer` — framework generates it |
| Using `createTaskCapableServer` instead of `createAdcpServer` | `createAdcpServer` handles server setup and capabilities — use it even when registering tools manually |
| `acquire_rights` missing `rights_id` in response | Echo `rights_id` from request — required for validation          |
| `update_rights` missing `rights_id` in response  | Same — echo `rights_id` back                                    |
| `creative_approval` returns `status` not `decision` | Field name is `decision`, values: `approved`, `rejected`, `review` |
| Using typed schemas for brand rights tools       | No generated schemas — use `{}` for all input schemas            |
| Dropping `context` from responses              | Echo `args.context` back unchanged in every response — buyers use it for correlation |

## Storyboards

| Storyboard     | Tests                                                            |
| -------------- | ---------------------------------------------------------------- |
| `brand_rights` | Full lifecycle: discover brand → browse rights → acquire → approve creative |

## Reference

- `storyboards/brand_rights.yaml` — full brand rights storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
