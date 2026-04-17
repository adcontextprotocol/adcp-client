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
- User references `get_brand_identity`, `get_rights`, or `acquire_rights`

**Not this skill:**

- Selling ad inventory → `skills/build-seller-agent/`
- Managing creative formats/library → `skills/build-creative-agent/`
- Evaluating media buys → `skills/build-governance-agent/`

## Before Writing Code

### 1. What Brand?

Define the brand this agent represents:
- Brand name (locale-keyed for i18n), domain, logos
- House identity (parent organization)
- What languages/markets the brand operates in

### 2. What Rights Are Available?

Define licensable rights:
- **Image usage** — use brand images in digital ads
- **AI generation** — generate new creatives using brand assets
- **Logo placement** — use brand logo in ads
- **Talent likeness** — use a person's likeness in generated content

Each right needs pricing (flat_rate, cpm, etc.) and uses (likeness, voice, commercial, ai_generated_image, etc.).

### 3. Approval Criteria

How are generated creatives reviewed?
- **Auto-approve** — passes basic checks, instantly approved
- **Guidelines check** — validate against brand standards
- **Human review** — queue for manual review

## Protocol Status

Three tools are first-class in the `brandRights` domain group. Two additional operations are spec-tracked but not yet schema-backed.

| Operation            | Status                                        | How to implement                                        |
| -------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `get_brand_identity` | Published schema — `brand/get-brand-identity` | `brandRights.getBrandIdentity` handler                  |
| `get_rights`         | Published schema — `brand/get-rights`         | `brandRights.getRights` handler                         |
| `acquire_rights`     | Published schema — `brand/acquire-rights`     | `brandRights.acquireRights` handler                     |
| `update_rights`      | Spec prose only — no JSON schema              | HTTP endpoint outside MCP surface                       |
| `creative_approval`  | Webhook contract, no JSON schema              | HTTP endpoint your agent hosts (URL returned in `acquire_rights`) |

Upstream tracking for the two schema gaps: https://github.com/adcontextprotocol/adcp/issues/2253. The SDK will register handlers for both once schemas land.

## Tools and Required Response Shapes

**`get_brand_identity`** — returns brand identity matching `brand/get-brand-identity-response.json`

Required: `brand_id`, `house`, `names` (array of locale-keyed objects).

```typescript
{
  brand_id: 'acme_outdoor',
  house: {
    domain: 'acme.example',
    name: 'Acme Corporation',
  },
  names: [
    { en_US: 'Acme Outdoor' },   // locale-specific
    { en: 'Acme Outdoor' },      // language wildcard
  ],
  logos: [
    {
      url: 'https://cdn.acme.example/logo-primary.svg',
      orientation: 'horizontal',  // horizontal | vertical | square
      background: 'light',        // light | dark | transparent
      variant: 'primary',
      width: 512,
      height: 128,
    },
  ],
  voice: 'Confident, outdoorsy, direct.',
  // context echoed back by the framework when present
}
```

**`get_rights`** — returns matching rights with pricing

Each right requires `rights_id`, `brand_id`, `name`, `available_uses`, `pricing_options`.

```typescript
{
  rights: [
    {
      rights_id: 'img_gen_standard',
      brand_id: 'acme_outdoor',
      name: 'AI image generation — standard',
      available_uses: ['ai_generated_image', 'commercial'],  // from right-use enum
      pricing_options: [
        {
          pricing_option_id: 'monthly_standard',
          model: 'flat_rate',                  // from pricing-model enum
          price: 2500,
          currency: 'USD',
          uses: ['ai_generated_image', 'commercial'],
          period: 'monthly',
        },
      ],
    },
  ],
}
```

**`acquire_rights`** — returns a discriminated union on `status`

Three success variants plus an error variant. The most common is `acquired`:

```typescript
{
  rights_id: 'img_gen_standard',     // echoed from request
  status: 'acquired',
  brand_id: 'acme_outdoor',
  terms: { /* rights-terms.json shape */ },
  generation_credentials: [ /* generation-credential refs */ ],
  rights_constraint: { /* pre-built rights-constraint for creative manifests */ },
}
// or
{ rights_id, status: 'pending_approval', brand_id, detail?, estimated_response_time? }
// or
{ rights_id, status: 'rejected', brand_id, reason, suggestions? }
```

**Creative approval (webhook you host).** Your `acquire_rights` response returns an `approval_webhook` — a `push-notification-config` pointing at an HTTP endpoint *your agent hosts*. The buyer POSTs a `creative-approval-request` there when a generated creative needs review; you return a `creative-approval-response`.

```typescript
// In your acquire_rights response
{
  // ...other fields
  approval_webhook: {
    url: 'https://brand.example/webhooks/creative-approval',
    authentication: {
      schemes: ['Bearer'],
      credentials: '<token the buyer sends as Authorization header>',
    },
  },
}
```

**Payload shapes (spec-tracked, not yet published):** the spec names these `creative-approval-request` and `creative-approval-response` but has not published the JSON schemas (tracked in https://github.com/adcontextprotocol/adcp/issues/2253). Design your endpoint to accept the creative reference (at minimum `rights_grant_id` and the creative being reviewed) and return a decision. Don't ship a concrete shape against this skill until schemas land — your handler contract may need to change.

**Revocation webhook (buyer side).** The `acquire_rights` *request* includes a required `revocation_webhook`. Store it against the rights grant. If you ever need to revoke the grant (credential rotation, terms violation, brand takedown), POST a `revocation-notification` to that URL using its `authentication` block. The `revocation-notification` payload shape is also not yet published — same tracking issue.

### Context and Ext Passthrough

Every AdCP request may include a `context` field. The framework echoes it back on success and error responses automatically when you use `createAdcpServer`. Do not read, modify, or omit `context` in your handler — treat it as opaque.

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `createAdcpServer({ brandRights: { ... } })`            | Register brand rights handlers as a first-class domain group        |
| `serve(() => createAdcpServer(...))`                    | Start HTTP server on `:3001/mcp`                                    |
| `adcpError(code, { message })`                          | Structured error (BRAND_NOT_FOUND, RIGHTS_UNAVAILABLE, etc.)        |

Import: `import { createAdcpServer, serve, adcpError } from '@adcp/client';`

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

## Implementation

Single `.ts` file, one `createAdcpServer` call with a `brandRights` domain group. The framework:
- Auto-registers `get_adcp_capabilities` declaring `brand` as a supported protocol
- Echoes `context` on success and error responses
- Validates `get_brand_identity`, `get_rights`, `acquire_rights` against their Zod schemas

Creative-approval webhooks are implemented as a regular outbound HTTP call — outside the MCP server, after you accept `acquire_rights`.

```typescript
import { createAdcpServer, serve, adcpError } from '@adcp/client';

serve(() =>
  createAdcpServer({
    name: 'Acme Brand Rights Agent',
    version: '1.0.0',
    capabilities: { major_versions: [3] },

    brandRights: {
      async getBrandIdentity(params) {
        if (params.brand_id !== 'acme_outdoor') {
          return adcpError('BRAND_NOT_FOUND', {
            message: `Brand ${params.brand_id} is not managed by this agent`,
          });
        }
        return {
          brand_id: 'acme_outdoor',
          house: { domain: 'acme.example', name: 'Acme Corporation' },
          names: [{ en_US: 'Acme Outdoor' }, { en: 'Acme Outdoor' }],
          logos: [
            {
              url: 'https://cdn.acme.example/logo.svg',
              orientation: 'horizontal',
              background: 'transparent',
              variant: 'primary',
              width: 512,
              height: 128,
            },
          ],
        };
      },

      async getRights(params) {
        return {
          rights: [
            {
              rights_id: 'img_gen_standard',
              brand_id: 'acme_outdoor',
              name: 'AI image generation — standard',
              available_uses: ['ai_generated_image', 'commercial'],
              pricing_options: [
                {
                  pricing_option_id: 'monthly_standard',
                  model: 'flat_rate',
                  price: 2500,
                  currency: 'USD',
                  uses: ['ai_generated_image', 'commercial'],
                  period: 'monthly',
                },
              ],
            },
          ],
        };
      },

      async acquireRights(params) {
        const campaignEnd = new Date(params.campaign?.end_date ?? 0);
        if (campaignEnd < new Date()) {
          return adcpError('INVALID_REQUEST', {
            message: 'Campaign end_date is in the past',
            field: 'campaign.end_date',
          });
        }
        const grantId = `grant_${Date.now()}`;
        // Persist params.revocation_webhook against grantId so you can call it
        // if you later need to revoke (credential rotation, terms violation).
        return {
          rights_id: params.rights_id,
          status: 'acquired',
          brand_id: 'acme_outdoor',
          terms: {
            countries: ['US', 'CA'],
            exclusivity: 'non_exclusive',
          },
          generation_credentials: [],
          rights_constraint: {
            brand_id: 'acme_outdoor',
            uses: params.campaign?.uses ?? [],
          },
          // URL you host — buyer POSTs creative-approval-request here for review.
          approval_webhook: {
            url: `https://brand.example/webhooks/approval/${grantId}`,
            authentication: {
              schemes: ['Bearer'],
              credentials: '<token your endpoint validates>',
            },
          },
        };
      },
    },
  })
);
```

The skill contains everything you need. Do not read additional docs before writing code.

## Validation

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp brand_rights --json
```

**Keep iterating until all steps pass.**

## Common Mistakes

| Mistake                                           | Fix                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `names: [{name, language}]`                       | `names` is an array of locale-keyed objects: `[{en_US: "Acme"}]`     |
| `pricing_options` using `pricing_model`/`fixed_price` | Schema uses `model` + `price` + `currency` + `uses`                |
| `uses` containing `digital_display` etc.          | Only values from `right-use` enum (likeness, voice, ai_generated_image, commercial, ...) |
| `logos` with `format: 'png'`                      | Use `orientation`, `background`, `variant`, plus optional `width`/`height` — derive format from the URL extension |
| Acquire rights returning `status: 'active'`       | Valid values are `acquired`, `pending_approval`, `rejected`          |
| Treating `approval_webhook` as a URL the buyer supplies | The seller *returns* `approval_webhook` in `acquire_rights` response. The buyer POSTs `creative-approval-request` to that URL later — your agent hosts the endpoint. |
| Shipping a concrete `creative-approval-request` shape | Spec names the payload but has not published the schema (see https://github.com/adcontextprotocol/adcp/issues/2253). Treat the body as TBD; don't lock buyers into an invented shape. |
| Dropping `context` from responses                 | Framework echoes it automatically — don't read or write it yourself  |

## Storyboards

| Storyboard     | Tests                                                            |
| -------------- | ---------------------------------------------------------------- |
| `brand_rights` | Discover brand → browse rights → acquire license → enforce expired campaigns (update/approval covered once spec schemas land) |

## Reference

- `storyboards/brand_rights.yaml` — full brand rights storyboard
- `schemas/cache/latest/brand/` — JSON schemas (ground truth for request/response shapes)
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
