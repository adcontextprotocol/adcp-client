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

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `serve(createAgent)`                                    | Start HTTP server on `:3001/mcp`                                    |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support                                 |
| `server.tool(name, Schema.shape, handler)`              | Register tool — `.shape` unwraps Zod                                |
| `capabilitiesResponse(data)`                            | Build `get_adcp_capabilities` response                              |
| `taskToolResponse(data, summary)`                       | Build tool response (used for all brand rights tools)               |

Brand rights tools use `{}` for input schemas (no generated request schemas). Register with `server.tool('get_brand_identity', {}, handler)`.

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
3. All brand rights tools use `{}` as input schema
4. Use in-memory Maps for rights grants
5. Use `ServeContext` pattern: `function createAgent({ taskStore }: ServeContext)`

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
| `acquire_rights` missing `rights_id` in response | Echo `rights_id` from request — required for validation          |
| `update_rights` missing `rights_id` in response  | Same — echo `rights_id` back                                    |
| `creative_approval` returns `status` not `decision` | Field name is `decision`, values: `approved`, `rejected`, `review` |
| Using typed schemas for brand rights tools       | No generated schemas — use `{}` for all input schemas            |

## Storyboards

| Storyboard     | Tests                                                            |
| -------------- | ---------------------------------------------------------------- |
| `brand_rights` | Full lifecycle: discover brand → browse rights → acquire → approve creative |

## Reference

- `storyboards/brand_rights.yaml` — full brand rights storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
