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
- User references `get_brand_identity`, `get_rights`, `acquire_rights`, `update_rights`, or `creative_approval`

**Not this skill:**

- Selling ad inventory → `skills/build-seller-agent/`
- Managing creative formats/library → `skills/build-creative-agent/`
- Evaluating media buys → `skills/build-governance-agent/`

## Specialisms This Skill Covers

| Specialism     | Status | Delta                                                                                                                                                                                  |
| -------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `brand-rights` | stable | First-class tools: `get_brand_identity`, `get_rights`, `acquire_rights`, `update_rights`. `creative_approval` is webhook-only — wire your HTTP receiver at the `approval_webhook` URL. | [§ brand-rights](#specialism-brand-rights) |

Storyboard: `brand_rights`. The specialism tests identity discovery → rights search → acquisition → enforcement (including expired-campaign denial).

## Protocol-Wide Requirements

Full treatment in `skills/build-seller-agent/SKILL.md` §Protocol-Wide Requirements and §Composing. Minimum viable pointers:

- **`idempotency_key`** on every mutating request (`acquire_rights`, `update_rights`, and the `creative_approval` webhook payload). Wire `createIdempotencyStore` into `createAdcpServer({ idempotency })`. The framework auto-applies idempotency middleware to mutating tools; for the `creative_approval` webhook receiver, validate `idempotency_key` yourself and replay the cached verdict on resubmission.
- **Authentication** via `serve({ authenticate })` with `verifyApiKey`/`verifyBearer` from `@adcp/sdk/server`. Unauthenticated agents fail the universal `security_baseline` storyboard.
- **Signature-header transparency**: accept `Signature-Input`/`Signature` headers even if you don't claim `signed-requests`.

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

Four MCP/A2A tools are first-class in the `brandRights` domain group. `creative_approval` is webhook-only — the spec models it as an HTTP POST from the buyer to the `approval_webhook` URL the seller returned in `acquire_rights`.

| Operation            | Status                                          | How to implement                                                                                       |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `get_brand_identity` | Published schema — `brand/get-brand-identity`   | `brandRights.getBrandIdentity` handler                                                                 |
| `get_rights`         | Published schema — `brand/get-rights`           | `brandRights.getRights` handler                                                                        |
| `acquire_rights`     | Published schema — `brand/acquire-rights`       | `brandRights.acquireRights` handler                                                                    |
| `update_rights`      | Published schema — `brand/update-rights`        | `brandRights.updateRights` handler (mutating)                                                          |
| `creative_approval`  | Published schema — `brand/creative-approval`    | Webhook receiver at the URL you returned in `acquire_rights.approval_webhook`; dispatch to `brandRights.reviewCreativeApproval` |

<a name="specialism-brand-rights"></a>

## Tools and Required Response Shapes

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``(e.g.`#### \`acquire_rights\``) to read the exact required + optional field list.** The schema-derived contract lives there; this skill covers patterns, gotchas, and domain-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift, so write the obvious thing and trust the contract.
>
> **Cross-cutting pitfalls matrix runs keep catching:**
>
> - **Declare `capabilities: { specialisms: ['brand-rights'] }` on `createAdcpServer`.** Value is `string[]` of enum ids (not `[{id, version}]`). Agents that don't declare their specialism fail the grader with "No applicable tracks found" even if every tool works — tracks are gated on the specialism claim.

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
      orientation: 'horizontal',          // horizontal | vertical | square
      background: 'transparent-bg',       // dark-bg | light-bg | transparent-bg
      variant: 'primary',
      width: 512,
      height: 128,
    },
  ],
  tone: {                                 // brand voice lives under `tone`, not at the top level
    voice: 'Confident, outdoorsy, direct.',
  },
  // context echoed back by the framework when present
}
```

**`get_rights`** — returns matching rights with pricing

Each right requires `rights_id`, `brand_id`, `name`, `available_uses`, `pricing_options`.

The `right-use` enum at `/schemas/latest/enums/right-use.json` is: `likeness | voice | name | endorsement | motion_capture | signature | catchphrase | sync | background_music | editorial | commercial | ai_generated_image | image_generation`.

```typescript
{
  rights: [
    {
      rights_id: 'likeness_commercial_standard',
      brand_id: 'acme_outdoor',
      name: 'Likeness for commercial use — standard',
      available_uses: ['likeness', 'commercial'],
      pricing_options: [
        {
          pricing_option_id: 'monthly_standard',
          model: 'flat_rate',                 // from pricing-model enum
          price: 2500,
          currency: 'USD',
          uses: ['likeness', 'commercial'],
          period: 'monthly',
        },
      ],
    },
  ],
}
```

**`acquire_rights`** — returns a discriminated union on `status`

Three success variants plus an error variant. The most common is `acquired`. Three shapes need exact field names to satisfy the spec schemas — `terms` must match `rights-terms.json` (required: `pricing_option_id`, `amount`, `currency`, `uses`), `rights_constraint` must match `/schemas/latest/core/rights-constraint.json` (required: `rights_id`, `rights_agent`, `uses`), and `approval_webhook.authentication.credentials` requires `minLength: 32`.

```typescript
{
  rights_id: 'likeness_commercial_standard',   // echoed from request
  status: 'acquired',
  brand_id: 'acme_outdoor',
  terms: {
    pricing_option_id: 'monthly_standard',     // required
    amount: 2500,                              // required
    currency: 'USD',                           // required
    uses: ['likeness', 'commercial'],          // required
    period: 'monthly',
    start_date: '2026-04-01T00:00:00Z',
    end_date:   '2026-05-01T00:00:00Z',
    exclusivity: { scope: 'non_exclusive', countries: ['US', 'CA'] },    // object per rights-terms.json: { scope, countries }
  },
  generation_credentials: [ /* generation-credential refs */ ],
  rights_constraint: {
    rights_id: 'likeness_commercial_standard', // required — NOT brand_id
    rights_agent: {                            // required — {url, id} pointing at this agent
      url: 'https://brand.example/mcp',
      id: 'acme_outdoor',
    },
    uses: ['likeness', 'commercial'],          // required
  },
  approval_webhook: {
    url: 'https://brand.example/webhooks/creative-approval',
    authentication: {
      schemes: ['Bearer'],
      credentials: 'brand-approval-webhook-secret-32chars+',  // minLength: 32
    },
  },
}
// or
{ rights_id, status: 'pending_approval', brand_id, detail?, estimated_response_time? }
// or
{ rights_id, status: 'rejected', brand_id, reason, suggestions? }
```

**`update_rights`** — returns either a success arm (with re-issued credentials) or the error arm

Mutating; framework auto-applies idempotency middleware. Carry only the fields you're changing — omitted fields stay at their current value (parallels `update_media_buy` semantics). The framework hydrates the underlying grant from `rights_id`, so handlers read the resolved grant from `ctx.store`.

```typescript
// Success — change applied
{
  rights_id: 'likeness_commercial_standard',
  terms: { /* updated rights-terms shape */ },
  generation_credentials: [ /* re-issued with the new constraint */ ],
  rights_constraint: { /* updated for re-embedding in creative manifests */ },
  paused: false,
  implementation_date: '2026-05-02T19:00:00Z',  // string when live immediately
}
// Pending rights-holder approval
{
  rights_id: 'likeness_commercial_standard',
  terms: { /* updated terms */ },
  implementation_date: null,                     // null = follow-up via push_notification_config webhook
}
// Error — buyer-fixable rejection. Throw `adcpError('INVALID_REQUEST', ...)`
// for single-error cases; the multi-error arm is for batch failures.
{
  errors: [{ code: 'INVALID_REQUEST', message: 'impression_cap below delivered count' }],
}
```

Common rejections to surface as errors: `impression_cap` below already-delivered count, `end_date` earlier than current `end_date`, switching to a `pricing_option_id` from a different `get_rights` offering than the original.

**Creative approval (webhook).** The `approval_webhook` in your `acquire_rights` response is a URL **your agent hosts** — the buyer POSTs `CreativeApprovalRequest` there when a generated creative needs review. Schema is published in 3.0.x (`brand/creative-approval-{request,response}.json`); the SDK does NOT register this as an MCP/A2A tool because it's webhook-only.

The receiver pattern: validate the request body with `CreativeApprovalRequestSchema`, dispatch to `brandRights.reviewCreativeApproval(req, ctx)`, and serialize the result with the typed builders.

```typescript
import express from 'express';
import {
  creativeApproved,
  creativeApprovalRejected,
  creativeApprovalPendingReview,
} from '@adcp/sdk/server';
import { CreativeApprovalRequestSchema } from '@adcp/sdk/types';

const app = express();
app.use(express.json());

app.post('/webhooks/creative-approval', async (req, res) => {
  const parsed = CreativeApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: [{ code: 'INVALID_REQUEST', message: 'malformed creative-approval request' }] });
  }
  // Idempotency — replay the cached verdict if you've seen this key.
  const cached = await idempotencyStore.get(parsed.data.idempotency_key);
  if (cached) return res.json(cached);

  // Dispatch to the platform — same `reviewCreativeApproval` method shape
  // as if it were a tool. The framework doesn't auto-wire HTTP for webhook-
  // only surfaces, so adopters host the route themselves.
  try {
    const verdict = await platform.brandRights.reviewCreativeApproval(parsed.data, /* ctx built per request */);
    await idempotencyStore.set(parsed.data.idempotency_key, verdict);
    return res.json(verdict);
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'INTERNAL_ERROR', message: err.message }] });
  }
});
```

Three success arms (Approved / Rejected / PendingReview) plus an error arm. Arm choice depends on review pipeline — auto-approve immediately, route to human review, or pre-flight reject for hard violations. Use the typed builders so the discriminator (`status`) is injected for you:

```typescript
// Approved
creativeApproved({
  rights_id: 'likeness_commercial_standard',
  creative_id: 'cr_42',
  creative_url: 'https://buyer.example.com/creatives/42.mp4',
  approved_at: new Date().toISOString(),
  conditions: ['approved for NL only'],   // optional
});

// Rejected
creativeApprovalRejected({
  rights_id: 'likeness_commercial_standard',
  creative_id: 'cr_42',
  reason: 'logo not visible per brand standards',
  suggestions: ['enlarge the logo to 15% of the frame'],
});

// Pending — buyer polls `status_url` or waits up to `estimated_response_time`
creativeApprovalPendingReview({
  rights_id: 'likeness_commercial_standard',
  creative_id: 'cr_42',
  estimated_response_time: '24h',
  status_url: 'https://brand.example/approvals/cr_42',
});
```

**Revocation webhook.** The `acquire_rights` _request_ carries a required `revocation_webhook`. Persist it against the grant. When you need to revoke (credential rotation, terms violation, brand takedown), use `ctx.emitWebhook` — don't hand-roll `fetch`. See [`skills/build-seller-agent/SKILL.md`](../build-seller-agent/SKILL.md) § Webhooks for the full wiring; minimal call:

```typescript
await ctx.emitWebhook!({
  url: storedGrant.revocation_webhook.url,
  payload: { rights_id: storedGrant.rights_id, reason: 'credential_rotation', effective_at: new Date().toISOString() },
  operation_id: `revoke_rights.${storedGrant.rights_id}`, // stable across retries, NOT a fresh UUID
});
```

3.0 GA renamed `RevocationNotification.notification_id` → `idempotency_key` — the emitter populates it for you when `operation_id` is set.

### Context and Ext Passthrough

Every AdCP request may include a `context` field. The framework echoes it back on success and error responses automatically when you use `createAdcpServer`. Do not read, modify, or omit `context` in your handler — treat it as opaque.

## SDK Quick Reference

| SDK piece                                    | Usage                                                        |
| -------------------------------------------- | ------------------------------------------------------------ |
| `createAdcpServer({ brandRights: { ... } })` | Register brand rights handlers as a first-class domain group |
| `serve(() => createAdcpServer(...))`         | Start HTTP server on `:3001/mcp`                             |
| `adcpError(code, { message })`               | Structured error (BRAND_NOT_FOUND, RIGHTS_UNAVAILABLE, etc.) |

Import: `import { createAdcpServer, serve, adcpError } from '@adcp/sdk/server/legacy/v5';`

> **v6 specialism status.** `brandRights` is wired via the v5 `createAdcpServer` handler bag today. A v6 `BrandRightsPlatform` interface ships at `src/lib/server/decisioning/specialisms/brand-rights.ts` but the dispatcher path through `createAdcpServerFromPlatform` is not yet documented for adopters — pin to the legacy subpath until that lands.

## Setup

```bash
npm init -y
npm install @adcp/sdk
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
import {
  createAdcpServer,
  serve,
  adcpError,
  createIdempotencyStore,
  memoryBackend,
} from '@adcp/sdk/server/legacy/v5';

// Idempotency — required for v3. `acquire_rights` is mutating (issues
// credentials + may trigger billing); `get_brand_identity` and
// `get_rights` are read-only and exempt.
const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // pgBackend(pool) for production
  ttlSeconds: 86400, // 24 hours (spec bounds: 1h–7d)
});

serve(() =>
  createAdcpServer({
    name: 'Acme Brand Rights Agent',
    version: '1.0.0',
    capabilities: { major_versions: [3] },
    idempotency,

    // Principal scoping for idempotency. MUST never return undefined — or
    // every mutating request rejects as SERVICE_UNAVAILABLE.
    resolveSessionKey: () => 'default-principal',

    // Accounts domain — required for the governance_denied scenario. Buyers
    // call sync_accounts to register their operator/billing relationship, then
    // sync_governance to point the brand agent at their governance agent.
    accounts: {
      async syncAccounts(params, ctx) {
        for (const account of params.accounts) {
          // `ctx.store.put` rejects keys outside `[A-Za-z0-9_.\-:]` — use `:`
          // as the composite-key separator (not `|`, which the store rejects).
          const key = `${account.brand.domain}:${account.operator}`;
          await ctx.store.put('accounts', key, {
            ...account,
            account_id: `acct_${key}`,
            status: 'active',
          });
        }
        return {
          accounts: params.accounts.map(account => ({
            brand: account.brand,
            operator: account.operator,
            account_id: `acct_${account.brand.domain}:${account.operator}`,
            status: 'active' as const,
            action: 'created' as const, // required — one of 'created'|'updated'|'unchanged'|'failed'
          })),
        };
      },

      async syncGovernance(params, ctx) {
        for (const acc of params.accounts) {
          const key = `${acc.account.brand.domain}:${acc.account.operator}`;
          await ctx.store.put('governance', key, {
            governance_agents: acc.governance_agents,
          });
        }
        return {
          status: 'synced' as const,
          governance_agents: params.accounts.flatMap(a => a.governance_agents),
        };
      },
    },

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

      async acquireRights(params, ctx) {
        const campaignEnd = new Date(params.campaign?.end_date ?? 0);
        if (campaignEnd < new Date()) {
          return adcpError('INVALID_REQUEST', {
            message: 'Campaign end_date is in the past',
            field: 'campaign.end_date',
          });
        }

        // Governance check — REQUIRED before issuing a rights license. Acquiring
        // rights is a spending event; the `brand_rights/governance_denied` scenario
        // expects GOVERNANCE_DENIED when the buyer's plan denies the spend.
        // 1. Look up the governance agent the buyer registered via sync_governance
        //    (accountKey = brand.domain + operator, stored by syncAccounts/syncGovernance).
        // 2. Call check_governance on it; propagate findings on denial.
        if (!params.account?.brand?.domain || !params.account?.operator) {
          return adcpError('INVALID_REQUEST', {
            message: 'acquire_rights requires account.brand.domain and account.operator',
            field: 'account',
          });
        }
        const accountKey = `${params.account.brand.domain}:${params.account.operator}`;
        const registration = await ctx.store.get('governance', accountKey);
        if (registration?.governance_agents?.length) {
          const { checkGovernance } = await import('@adcp/sdk'); // buyer-side helper
          const plan = await checkGovernance({
            agentUrl: registration.governance_agents[0].url,
            plan_id: params.plan_id ?? registration.plan_id,
            caller: { role: 'brand_agent', id: AGENT_URL },
            tool: 'acquire_rights',
            payload: {
              rights_id: params.rights_id,
              pricing_option_id: params.pricing_option_id,
              total_cost: { amount: 2500, currency: 'USD' },
            },
          });
          if (plan.status === 'denied') {
            return adcpError('GOVERNANCE_DENIED', {
              message: plan.explanation ?? 'Governance agent denied this rights acquisition.',
              findings: plan.findings ?? [], // propagate verbatim
            });
          }
          // status === 'conditions' → you may attach conditions, or deny in strict mode
          // status === 'approved'  → fall through to issue the grant
        }

        const grantId = `grant_${Date.now()}`;
        // Persist params.revocation_webhook against grantId so you can call it
        // if you later need to revoke (credential rotation, terms violation).
        return {
          rights_id: params.rights_id,
          status: 'acquired',
          brand_id: 'acme_outdoor',
          terms: {
            pricing_option_id: 'monthly_standard', // required per rights-terms.json
            amount: 2500, // required
            currency: 'USD', // required
            uses: params.campaign?.uses ?? [], // required
            countries: ['US', 'CA'],
            exclusivity: { scope: 'non_exclusive', countries: ['US', 'CA'] }, // object, not string
          },
          generation_credentials: [],
          rights_constraint: {
            rights_id: params.rights_id, // required — NOT brand_id
            rights_agent: { url: AGENT_URL, id: 'acme_outdoor' }, // required — {url, id}
            uses: params.campaign?.uses ?? [], // required
          },
          // URL you host — buyer POSTs creative-approval-request here for review.
          // `credentials` MUST be ≥32 chars (spec: push-notification-config.json
          // minLength: 32). `randomUUID().replace(/-/g, '')` produces 32 hex chars.
          approval_webhook: {
            url: `https://brand.example/webhooks/approval/${grantId}`,
            authentication: {
              schemes: ['Bearer'],
              credentials: randomUUID().replace(/-/g, ''), // 32-char high-entropy token
            },
          },
        };
      },
    },
  })
);
```

The skill contains everything you need. Do not read additional docs before writing code.

## Idempotency & Auth

For brand-rights only `acquire_rights` is mutating (`get_brand_identity` and `get_rights` are reads). Wire `createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86400 })` into `createAdcpServer({ idempotency })` once — framework handles `INVALID_REQUEST` / `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_EXPIRED` / replay-with-`replayed:true` / atomic-claim. See [`skills/build-seller-agent/SKILL.md`](../build-seller-agent/SKILL.md) § Idempotency for the full framework contract.

Authentication is mandatory (otherwise `security_baseline` fails). Minimum viable:

```typescript
import { serve } from '@adcp/sdk';
import { verifyApiKey } from '@adcp/sdk/server';

serve(createAgent, {
  authenticate: verifyApiKey({
    keys: { 'compliance-runner': { principal: 'compliance-runner' } }, // replace with db-backed lookup in prod
  }),
});
```

For OAuth, `anyOf(verifyApiKey, verifyBearer)` composition, or `publicUrl` + `protectedResource` see [seller skill § Protecting your agent](../build-seller-agent/SKILL.md#protecting-your-agent).

## Validate Locally

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). Brand-rights-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy path — brand_rights bundle (includes governance_denied sub-scenario)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp brand_rights --auth $TOKEN

# Cross-cutting obligations
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation --auth $TOKEN

# Revocation webhook conformance (if you emit revocations)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp webhook_emission \
  --webhook-receiver --auth $TOKEN

# Rejection-surface fuzz
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp --auth-token $TOKEN
```

Common failure decoder:

- `exclusivity: 'non_exclusive'` (string) → must be object `{ scope, countries }` — see § Concept model
- `available_uses` enum mismatch → `right-use.json` enum is the source of truth; includes `ai_generated_image` in AdCP 3.0+
- `acquire_rights` rejected with `Invalid input` → buyer omitted required `revocation_webhook: { url }`

**Keep iterating until all steps pass.** Can't bind ports? `npm run compliance:skill-matrix -- --filter brand-rights` runs an isolated end-to-end test.

## Common Mistakes

| Mistake                                                 | Fix                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `names: [{name, language}]`                             | `names` is an array of locale-keyed objects: `[{en_US: "Acme"}]`                                                                                                                      |
| `pricing_options` using `pricing_model`/`fixed_price`   | Schema uses `model` + `price` + `currency` + `uses`                                                                                                                                   |
| `uses` containing `digital_display` etc.                | Only values from `right-use` enum (likeness, voice, ai_generated_image, commercial, ...)                                                                                              |
| `logos` with `format: 'png'`                            | Use `orientation`, `background`, `variant`, plus optional `width`/`height` — derive format from the URL extension                                                                     |
| Acquire rights returning `status: 'active'`             | Valid values are `acquired`, `pending_approval`, `rejected`                                                                                                                           |
| Treating `approval_webhook` as a URL the buyer supplies | The seller _returns_ `approval_webhook` in `acquire_rights` response. The buyer POSTs `creative-approval-request` to that URL later — your agent hosts the endpoint.                  |
| Shipping a concrete `creative-approval-request` shape   | Spec names the payload but has not published the schema (see https://github.com/adcontextprotocol/adcp/issues/2253). Treat the body as TBD; don't lock buyers into an invented shape. |
| Dropping `context` from responses                       | Framework echoes it automatically — don't read or write it yourself                                                                                                                   |

## Storyboards

| Storyboard     | Tests                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `brand_rights` | Discover brand → browse rights → acquire license → enforce expired campaigns (update/approval covered once spec schemas land) |

## Reference

- `storyboards/brand_rights.yaml` — full brand rights storyboard
- `schemas/cache/latest/brand/` — JSON schemas (ground truth for request/response shapes)
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
