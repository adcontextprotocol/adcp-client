---
name: build-governance-agent
description: Use when building an AdCP governance agent — a platform that evaluates media buys against spending authority, manages property lists, and enforces content standards.
---

# Build a Governance Agent

## Overview

A governance agent sits between buyers and sellers, evaluating proposed media buys against organizational policies. Three domains: campaign governance (spending authority, approval/denial), property governance (inclusion/exclusion lists for brand safety), and content standards (creative compliance rules). Determine which domains the user needs.

## When to Use

- User wants to build an agent that evaluates or approves media buys
- User mentions governance, brand safety, spending authority, property lists, or content standards
- User references `check_governance`, `sync_plans`, `create_property_list`, or `calibrate_content`

**Not this skill:**

- Selling ad inventory → `skills/build-seller-agent/`
- Serving audience segments → `skills/build-signals-agent/`
- Managing brand identity and licensing → `skills/build-brand-rights-agent/`

## Specialisms This Skill Covers

Your compliance obligations come from the specialisms you claim in `get_adcp_capabilities`. Each maps to a storyboard at `compliance/cache/latest/specialisms/<id>/`:

| Specialism                    | Status  | Delta from baseline                                                                                                                                                                                                                  | See                                                                      |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `governance-spend-authority`  | stable  | `check_governance` evaluates `binding` against Plan's `budget.total`, `human_review_required`, and `custom_policies`; return `approved`, `conditions`, or `denied`                                                                   | [§ governance-spend-authority](#specialism-governance-spend-authority)   |
| `governance-delivery-monitor` | stable  | `check_governance` with `phase: 'delivery'` + `delivery_metrics`; compute drift vs Plan's `budget.reallocation_threshold`; return `BUDGET_DRIFT_EXCEEDED` findings                                                                   | [§ governance-delivery-monitor](#specialism-governance-delivery-monitor) |
| `property-lists`              | stable  | Tool family `property_list` — implement CRUD plus `validate_property_delivery` with full `violations[]`                                                                                                                              | [§ property-lists](#specialism-property-lists)                           |
| `collection-lists`            | stable  | Tool family `collection_list` — program-level brand safety (shows, series, podcasts) identified by platform-independent IDs: IMDb, Gracenote, EIDR. Mirrors property-lists CRUD plus collection resolution.                          | [§ collection-lists](#specialism-collection-lists)                       |
| `content-standards`           | stable  | `policies[]` is an array of `{ policy_id, enforcement, policy, policy_categories?, channels? }`; `validate_content_delivery` uses `records[].artifact` (not `creative_id`); re-read policies per call for `standards_version_change` | [§ content-standards](#specialism-content-standards)                     |
| `measurement-verification`    | preview | v3.1 placeholder (empty `phases`). Pass universal + governance baseline only. Advertise `measurement_verification` capability for discoverability.                                                                                   | Baseline only                                                            |

**Not in this skill:** `audience-sync` lives under `protocol: media-buy`. Build it in `skills/build-seller-agent/` instead — it uses `sync_audiences` (overloaded for discovery, add, and delete) and `list_accounts` under the `accounts` / `eventTracking` domain groups.

Specialism ID (kebab-case) = storyboard directory. Storyboard `id:` (snake_case, e.g. `campaign_governance_conditions`) is the category name — multiple specialisms can reference the same storyboard category.

## Protocol-Wide Requirements

Every production governance agent — regardless of specialism — must wire these. Full treatment in `skills/build-seller-agent/SKILL.md` §Protocol-Wide Requirements and §Composing OAuth, signing, and idempotency; minimum-viable pointers:

- **`idempotency_key`** on every mutating request (`sync_plans`, `create_property_list`/`update_property_list`/`delete_property_list`, `create_collection_list`/`update_collection_list`/`delete_collection_list`, `create_content_standards`/`update_content_standards`, `calibrate_content`). Wire `createIdempotencyStore` into `createAdcpServer({ idempotency })`.
- **Authentication** via `serve({ authenticate: verifyApiKey(...)/verifyBearer(...) })` from `@adcp/client/server`. Unauthenticated agents fail the universal `security_baseline` storyboard.
- **Signature-header transparency**: don't reject requests that carry `Signature-Input`/`Signature` headers even if you don't claim `signed-requests`.
- **Resolve-then-authorize** on id lookups (`get_property_list`, `get_content_standards`, `get_collection_list`): return byte-equivalent errors whether the id is cross-tenant or nonexistent — always `REFERENCE_NOT_FOUND`, never `PERMISSION_DENIED`. `adcp fuzz` runs a paired-probe invariant that enforces this; stand up two test tenants and pass `--auth-token` + `--auth-token-cross-tenant` for full coverage. See `skills/build-seller-agent/SKILL.md` §Resolve-then-authorize for the full rules.
- **`comply_test_controller`** — required to pass the `governance_spend_authority` and `property_lists` storyboards. Each seeds fixtures via `comply_test_controller.seed_plan` / `seed_property_list` before running the business-logic phases. Register via `createComplyController({ seed: { plan, property_list, collection_list, content_standards } })` and call `controller.register(server)` — same pattern as seller. Full treatment in `skills/build-seller-agent/SKILL.md` §Compliance Testing. Without it, all business-logic steps skip with `missing_test_controller` and the track vacuously "passes" (no tests run, vacuous green detected by the grader as fail).

## Before Writing Code

### 1. Which Governance Domains?

- **Campaign governance** — evaluates media buys against spending authority. Returns approved, denied, or approved with conditions.
- **Property governance** — maintains inclusion/exclusion lists of publisher properties for brand safety.
- **Content standards** — defines creative compliance rules and validates delivery against them.

Most governance agents start with campaign governance. Add property and content standards as needed.

### 2. Decision Logic

For campaign governance, how should the agent decide?

- **Budget threshold** — deny buys over a per-transaction limit
- **Policy conditions** — approve with conditions (e.g., "weekly reporting required for CTV")
- **Channel restrictions** — deny certain channels or require review
- **Delivery monitoring** — re-evaluate when spend drifts past threshold

### 3. Property List Types

- **Inclusion lists** — only serve ads on these properties
- **Exclusion lists** — never serve ads on these properties
- **GARM category filters** — exclude by IAB/GARM category

## Tools and Required Response Shapes

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``(e.g.`#### \`check_governance\``) to read the exact required + optional field list.** The schema-derived contract lives there; this skill covers patterns, gotchas, and domain-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift, so write the obvious thing and trust the contract.
>
> **Cross-cutting pitfalls matrix runs keep catching:**
>
> - `capabilities.specialisms` is `string[]` of enum ids (e.g. `['governance-spend-authority', 'property-lists']`), NOT `[{id, version}]` objects.
> - Every mutating-tool response (`create_property_list`, `create_collection_list`, `create_content_standards`, etc.) has `additionalProperties: false` — don't add extra fields. Return exactly what the schema declares.

### Campaign Governance

**`get_adcp_capabilities`** — register first, empty `{}` schema

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['governance'],
})
```

**`sync_plans`** — `SyncPlansRequestSchema.shape`

Register governance plans. Each plan in the response needs `plan_id`, `status`, and `version`.

```
taskToolResponse({
  plans: [{
    plan_id: string,       // required — echo from request
    status: 'active',      // required — 'active' | 'paused'
    version: 1,            // required — integer version number
  }],
})
```

**`check_governance`** — `CheckGovernanceRequestSchema.shape`

Evaluate a media buy against the registered plan. The request carries a `binding` (what is being evaluated) and a `phase`:

```
// Request shape:
{
  plan_id: string,              // required — registered via sync_plans
  phase?: 'create' | 'delivery',  // optional — authoritative when present
  binding: {                    // what to evaluate (create-phase)
    type: 'media_buy',
    media_buy_id?: string,      // on delivery phase, the already-created buy
    account: { brand: {...}, operator: string },
    total_budget: { amount: number, currency: string },
    packages: [{ product_id, pricing_option_id, budget }],
  },
  delivery_metrics?: {          // on delivery-phase checks — NOT delivery_evidence
    reporting_period: { start: string, end: string },
    spend: number,
    cumulative_spend: number,
    channel_distribution: { [channel: string]: number },  // percent by channel
    pacing: 'ahead' | 'on_pace' | 'behind',
  },
  governance_context?: string,  // prior check's context, for re-evaluation
}
```

`phase` is an optional top-level field (`'create' | 'delivery'`). When present, it is authoritative — use it to route. When absent, the presence of `delivery_metrics` is the corroborating signal. The storyboard sends both for delivery-phase checks.

The Plan object (stored via `sync_plans`) drives decisions. Expected shape:

```
{
  plan_id: string,
  brand: { domain: string },
  objectives: string,
  budget: {
    total: number,
    currency: string,
    // Exactly one of the next two is required:
    reallocation_threshold?: number,  // absolute currency amount the orchestrator can reallocate without human escalation
    reallocation_unlimited?: boolean, // set true for full autonomy up to total (prefer this over threshold == total)
  },
  flight: { start: string, end: string },
  countries: string[],
  human_review_required?: boolean,    // GDPR Art 22 / EU AI Act Annex III — when true, every action on this plan needs human review regardless of budget. Set automatically by the agent if any resolved policy has requires_human_review: true.
  custom_policies: [                  // array of structured policy objects — NOT bare strings
    {
      policy_id: string,
      enforcement: 'must' | 'should',
      policy: string,                 // prose description of the rule
    },
  ],
}
```

Authority is split into two independent concerns:

- **`budget.reallocation_threshold` / `reallocation_unlimited`** — budget autonomy. Dollar-denominated cap on how much the orchestrator can shift around without asking.
- **`human_review_required`** — decisions affecting data subjects (targeting, creative, delivery). Fires regardless of budget. Driven by regulation, not finance.

Both can be true simultaneously on the same plan.

The response needs `check_id`, `status`, `plan_id`, and `explanation`.

```
// Approved:
taskToolResponse({
  check_id: string,              // required — unique check identifier
  status: 'approved',            // required — enum: 'approved' | 'denied' | 'conditions'
  plan_id: string,               // required — echo from request
  explanation: string,           // required — human-readable explanation
  governance_context: string,    // pass to create_media_buy
})

// Approved with conditions — status is literally 'conditions' (not 'approved' plus a conditions array):
taskToolResponse({
  check_id: string,
  status: 'conditions',
  plan_id: string,
  explanation: 'Approved with conditions',
  conditions: [{                 // array of binding conditions
    field: string,               // required — what the condition applies to
    reason: string,              // required — why the condition exists
    required_value: string,      // optional — specific value required
  }],
  governance_context: string,
})

// Denied — also the way human review is signalled (no separate 'escalate' status):
taskToolResponse({
  check_id: string,
  status: 'denied',
  plan_id: string,
  explanation: 'Exceeds spending authority',
  findings: [{                   // array of policy findings
    category_id: string,         // required — policy category ID
    severity: 'info' | 'warning' | 'critical', // required — human-review signal uses 'critical'
    explanation: string,         // required — human-readable
  }],
})
```

**`get_plan_audit_logs`** — `GetPlanAuditLogsRequestSchema.shape`

```
taskToolResponse({
  plan_id: string,
  logs: [{
    timestamp: string,           // ISO timestamp
    action: string,
    actor: string,
  }],
})
```

### Property Governance

**`create_property_list`** — `CreatePropertyListRequestSchema.shape`

Response must include `list` object and `auth_token`.

```
taskToolResponse({
  list: {
    list_id: string,            // required
    name: string,               // required — echo from request
    description: string,
    property_count: 0,
  },
  auth_token: string,           // required — token for subsequent operations
})
```

**`get_property_list`** — `GetPropertyListRequestSchema.shape`

```
taskToolResponse({
  list: {
    list_id: string,
    name: string,
  },
})
```

**`update_property_list`** — `UpdatePropertyListRequestSchema.shape`

```
taskToolResponse({
  list: {
    list_id: string,
    name: string,
  },
})
```

**`list_property_lists`** — `ListPropertyListsRequestSchema.shape`

```
taskToolResponse({
  lists: [{
    list_id: string,
    name: string,
  }],
})
```

**`delete_property_list`** — `DeletePropertyListRequestSchema.shape`

```
taskToolResponse({
  deleted: true,                // required — boolean
  list_id: string,              // required — echo from request
})
```

**`validate_property_delivery`** — no generated schema, use `{}` for input

The storyboard's enforcement phase asserts per-record `violations` with list reference and severity. A minimal `{property, compliant}` response will pass schema but fail the behavioral checks.

```
// Request:
{
  list_id: string,
  records: [{
    record_id: string,
    property: { type: 'domain' | 'bundle_id' | ..., value: string },
    impressions: number,
  }],
}

// Response:
taskToolResponse({
  compliant: true,              // required — overall compliance
  list_id: string,              // echo from request
  results: [{
    record_id: string,          // echo
    property: { type, value },  // echo
    impressions: number,
    compliant: boolean,
    violations: [{              // empty when compliant
      list_id: string,
      list_type: 'inclusion' | 'exclusion',
      severity: 'critical',
      explanation: string,      // e.g. "Property {value} is not on inclusion list {name}"
    }],
  }],
  violations: [],               // flattened — all violations across results
})
```

### Content Standards

**`list_content_standards`** — `ListContentStandardsRequestSchema.shape`

```
taskToolResponse({
  standards: [{
    standards_id: string,
    name: string,
  }],
})
```

**`create_content_standards`** — `CreateContentStandardsRequestSchema.shape`

```
taskToolResponse({
  standards_id: string,         // required — generated ID
})
```

**`get_content_standards`** — `GetContentStandardsRequestSchema.shape`

`policies` is an array of structured rules. Each entry has a `policy_id`, enforcement level (`must` or `should`), a prose `policy` description, optional `policy_categories`, and optional `channels` scope. The prose lives **inside each entry**, not at the container level.

```
taskToolResponse({
  standards_id: string,
  name: string,
  policies: [
    {
      policy_id: 'no_violent_imagery',
      policy_categories: ['brand_safety'],
      enforcement: 'must',
      policy: 'No violent or controversial imagery',
    },
    {
      policy_id: 'min_display_dpi',
      policy_categories: ['imagery_quality'],
      enforcement: 'should',
      channels: ['display'],
      policy: 'Minimum 72 DPI for display assets',
    },
  ],
  scope: { languages_any: ['en'], description: 'Acme Outdoor creative standards' },
})
```

On `create_content_standards` / `update_content_standards`, the buyer sends the same `policies[]` array. Store it indexed by `standards_id` and re-read on every `calibrate_content` / `validate_content_delivery` call — the `standards_version_change` storyboard phase re-issues policies and expects the next calibration to reflect the update (a memoized calibration will fail that phase).

**`update_content_standards`** — `UpdateContentStandardsRequestSchema.shape`

```
taskToolResponse({
  success: true,
  standards_id: string,
})
```

**`calibrate_content`** — `CalibrateContentRequestSchema.shape`

Verdict mapping: any `enforcement: 'must'` violation → `'fail'`. Only `'should'` violations → `'review'`. No violations → `'pass'`. The `standards_version_change` phase depends on this — after policies update, the same artifact must flip verdicts.

```
taskToolResponse({
  verdict: 'pass' | 'fail' | 'review',
  confidence: 0.95,
  explanation: string,
  features: [],
})
```

**`validate_content_delivery`** — `ValidateContentDeliveryRequestSchema.shape`

The request uses `records[].artifact`, not `creative_id`. Each record scopes a served impression with `property_rid`, `artifact_id`, and `assets`. Response returns per-record compliance plus a `summary`.

```
// Request:
{
  standards_id: string,
  records: [{
    record_id: string,
    property_rid: string,
    artifact: {
      artifact_id: string,
      property_rid: string,
      description?: string,           // optional prose describing the ad — used by calibration matchers
      assets: [{                       // ARRAY of assets — not an object
        type: 'image' | 'video' | 'html' | 'text',
        url: string,
        width?: number,
        height?: number,
        duration_ms?: number,
      }],
    },
    impressions: number,
  }],
}

// Response:
taskToolResponse({
  summary: {
    compliant: true,
    total_impressions: number,
    non_compliant_impressions: 0,
  },
  results: [{
    record_id: string,             // echo from request
    artifact: {
      artifact_id: string,
      property_rid: string,
      description?: string,           // optional prose describing the ad — used by calibration matchers
      assets: [{                       // ARRAY of assets — not an object
        type: 'image' | 'video' | 'html' | 'text',
        url: string,
        width?: number,
        height?: number,
        duration_ms?: number,
      }],
    },
    impressions: number,
    compliant: boolean,
    violations: [{                 // empty when compliant
      rule: string,                // e.g. "No tobacco advertising"
      severity: 'must' | 'should',
      evidence: string,            // why it failed
      remediation: string,         // how to fix
    }],
  }],
})
```

### Context and Ext Passthrough

`createAdcpServer` auto-echoes the request's `context` into every response — **do not set `context` yourself in your handler return values.** The framework injects it post-handler only when the field isn't already present.

**Crucial:** `context` is schema-typed as an object. If your handler hand-sets a string or narrative description, validation fails with `/context: must be object` and the framework does not overwrite. Leave the field out entirely; the framework handles it.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `sync_governance`.

## SDK Quick Reference

| SDK piece                                | Usage                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `createAdcpServer({ name, governance })` | Create server with domain-grouped handlers and auto-generated capabilities |
| `serve(() => createAdcpServer(...))`     | Start HTTP server on `:3001/mcp`                                           |
| `ctx.store`                              | State persistence — `get/put/patch/delete/list` domain objects             |
| `adcpError(code, { message })`           | Structured error                                                           |

Handlers return raw data objects. The framework auto-wraps responses and auto-generates `get_adcp_capabilities` from registered handlers.

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

`skipLibCheck: true` avoids false-positive errors from transitive `.d.ts` files (e.g., `@opentelemetry/api`).

## Implementation

1. Single `.ts` file — use `createAdcpServer` with the `governance` domain group
2. Do not register `get_adcp_capabilities` — the framework generates it from registered handlers
3. Return raw data objects from handlers — the framework wraps responses automatically
4. Use `ctx.store` to persist plans, property lists, and content standards
5. Set `sandbox: true` on all mock/demo responses
6. Handlers receive `(params, ctx)` — `ctx.store` for state, `ctx.account` for resolved account

```typescript
import { randomUUID } from 'node:crypto';
import { createAdcpServer, serve } from '@adcp/client';
import { createIdempotencyStore, memoryBackend } from '@adcp/client/server';

const idempotency = createIdempotencyStore({
  backend: memoryBackend(),
  ttlSeconds: 86400,
});

serve(() =>
  createAdcpServer({
    name: 'Governance Agent',
    version: '1.0.0',
    idempotency,
    // MUST never return undefined — or every mutating request rejects as
    // SERVICE_UNAVAILABLE. See the Idempotency section for production guidance.
    resolveSessionKey: () => 'default-principal',

    governance: {
      syncPlans: async (params, ctx) => {
        for (const plan of params.plans) {
          await ctx.store.put('plan', plan.plan_id, plan);
        }
        return {
          plans: params.plans.map(p => ({
            plan_id: p.plan_id,
            status: 'active' as const,
            version: 1,
          })),
        };
      },
      checkGovernance: async (params, ctx) => {
        const plan = await ctx.store.get('plan', params.plan_id);
        // ... decision logic ...
        return {
          check_id: `chk_${randomUUID()}`,
          status: 'approved' as const,
          plan_id: params.plan_id,
          explanation: 'Within spending authority',
        };
      },
      // ... other governance handlers
    },
  })
);
```

**Decision logic for check_governance:**

Route decisions based on the plan state and request parameters:

- Compare request budget against plan's `budget.total`; enforce reallocation autonomy using `budget.reallocation_threshold` (denominated in `budget.currency`) or `budget.reallocation_unlimited: true` — exactly one must be set
- If `reallocation_threshold` is set and a reallocation exceeds it → require human review / deny
- If `plan.human_review_required: true` → action must escalate regardless of `mode` (advisory/audit cannot downgrade)
- Auto-flip `plan.human_review_required: true` when resolved `policy_categories` include `fair_housing | fair_lending | fair_employment | pharmaceutical_advertising`, or when `policy_ids` include `eu_ai_act_annex_iii`
- If `human_review_required: true` but the brand/brand-ref has no `data_subject_contestation` contact → emit a critical finding
- Require a `human_override` artifact (reason ≥20 chars, approver email) on re-sync to downgrade `human_review_required: true → false`
- If policy conditions match → approve with conditions
- If `phase: 'delivery'` → check delivery_metrics for drift

## Idempotency

AdCP v3 requires an `idempotency_key` on every mutating request — for governance agents that's `create_property_list` / `update_property_list` / `delete_property_list`, `create_content_standards` / `update_content_standards`, `sync_plans`, and `report_plan_outcome` (`check_governance` and the various `get_*` / `list_*` tools are read-only and exempt). Wire `createIdempotencyStore` from `@adcp/client/server` into `createAdcpServer` and the framework handles missing-key rejection (`INVALID_REQUEST`), JCS-canonicalized payload hashing, `IDEMPOTENCY_CONFLICT` on same-key-different-payload (no payload leaked in the error), `IDEMPOTENCY_EXPIRED` past the TTL, `replayed: true` envelope injection on cache hits, and automatic declaration of `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities`. Only successful responses cache — errors re-execute on retry so a failed `sync_plans` or outcome report can be retried cleanly. Scoping is per-principal via `resolveSessionKey` (or override with `resolveIdempotencyPrincipal`) — typically the operator / tenant id.

```typescript
import { createIdempotencyStore, memoryBackend } from '@adcp/client/server';

const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // or pgBackend(pool) for production
  ttlSeconds: 86400, // 3600–604800 per spec; throws if out of range
});

const server = createAdcpServer({
  idempotency,
  // MUST never return undefined — or every mutating request rejects as
  // SERVICE_UNAVAILABLE. A constant works for a demo; for multi-tenant
  // production, type the account via `createAdcpServer<MyAccount>({...})`
  // and use `(ctx) => ctx.account?.id`.
  resolveSessionKey: () => 'default-principal',
  // ... governance handlers (create/update/delete property lists, content standards, syncPlans, reportPlanOutcome)
});
```

## Protecting your agent

**An AdCP agent that accepts unauthenticated requests is non-compliant** (see `security_baseline` in the universal storyboard bundle). Ask the operator: "API key, OAuth, or both?" — then wire one of these into `serve()`.

```typescript
import { serve, verifyApiKey, verifyBearer, anyOf } from '@adcp/client';

// API key — simplest, good for B2B integrations
serve(createAgent, {
  authenticate: verifyApiKey({
    verify: async token => {
      const row = await db.api_keys.findUnique({ where: { token } });
      return row ? { principal: row.account_id } : null;
    },
  }),
});

// OAuth — best when buyers authenticate as themselves
const AGENT_URL = 'https://my-agent.example.com/mcp';
serve(createAgent, {
  publicUrl: AGENT_URL, // canonical RFC 8707 audience — also served as `resource` in protected-resource metadata
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: AGENT_URL, // MUST equal publicUrl
  }),
  protectedResource: { authorization_servers: ['https://auth.example.com'] },
});

// Both
serve(createAgent, {
  publicUrl: AGENT_URL,
  authenticate: anyOf(verifyApiKey({ verify: lookupKey }), verifyBearer({ jwksUri, issuer, audience: AGENT_URL })),
  protectedResource: { authorization_servers: [issuer] },
});
```

The framework produces RFC 6750-compliant `WWW-Authenticate: Bearer` 401s on failure, and serves `/.well-known/oauth-protected-resource<mountPath>` with `publicUrl` as the `resource` field so buyers get tokens bound to the right audience. The default JWT allowlist is asymmetric-only (RS*/ES*/PS\*/EdDSA) to prevent algorithm-confusion attacks.

## Validate Locally

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). Governance-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy paths — run the storyboards matching your claimed specialisms
npx @adcp/client@latest storyboard run http://localhost:3001/mcp \
  --storyboards governance_spend_authority,governance_spend_authority/denied,governance_delivery_monitor \
  --auth $TOKEN
npx @adcp/client@latest storyboard run http://localhost:3001/mcp \
  --storyboards property_lists,collection_lists,content_standards \
  --auth $TOKEN

# Cross-cutting obligations
npx @adcp/client@latest storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation,error_compliance --auth $TOKEN

# Rejection-surface fuzz — includes update_property_list / update_content_standards (Tier 3)
npx @adcp/client@latest fuzz http://localhost:3001/mcp --auto-seed --auth-token $TOKEN
```

Common failure decoder:

- `authority_level` field present → 3.0 GA removed it; use `human_review_required: boolean` instead
- `status: 'escalated'` on `check_governance` → enum is `approved` / `denied` / `conditions`
- Missing `check_id` on `check_governance` response → required; generate a unique ID per check
- `finding.code` / `finding.message` → schema requires `category_id`, `severity`, `explanation`

**Keep iterating until all steps pass.** Can't bind ports? `npm run compliance:skill-matrix -- --filter governance` runs an isolated end-to-end test.

## Common Mistakes

| Mistake                                                | Fix                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Manually registering `get_adcp_capabilities`           | Framework auto-generates it from registered handlers — do not register it yourself                    |
| Using `server.tool()` instead of domain groups         | Use `governance: { syncPlans, checkGovernance, ... }` — framework wires schemas and response builders |
| Using in-memory Maps for state                         | Use `ctx.store.put/get/patch/delete/list` — built-in state persistence                                |
| `check_governance` missing `check_id`                  | Generate a unique ID per check — required field                                                       |
| `check_governance` returns `decision` not `status`     | Field is `status`, not `decision`. Values: `approved`, `denied`, `conditions`                         |
| Conditions use `description` instead of `reason`       | Condition schema requires `field` and `reason`, not `condition_id` and `description`                  |
| Findings use `code`/`message` instead of proper fields | Finding schema requires `category_id`, `severity`, `explanation`                                      |
| `sync_plans` response missing `version`                | Each plan needs `version: 1` (integer) — required field                                               |
| `delete_property_list` missing `deleted: true`         | Boolean `deleted` field is required in response                                                       |
| `create_property_list` missing `auth_token`            | `auth_token` is required — generate a token string                                                    |
| Dropping `context` from responses                      | Echo `args.context` back unchanged in every response — buyers use it for correlation                  |

## Storyboards

| Storyboard                       | Tests                                                              |
| -------------------------------- | ------------------------------------------------------------------ |
| `campaign_governance_conditions` | Approved with conditions flow                                      |
| `campaign_governance_delivery`   | Delivery monitoring with drift re-evaluation                       |
| `campaign_governance_denied`     | Denied — buy exceeds spending authority                            |
| `property_lists`                 | Property list lifecycle: create, query, update, delete, validate   |
| `collection_lists`               | Collection list lifecycle: create, query (resolve), update, delete |
| `content_standards`              | Content standards lifecycle: create, calibrate, validate           |

## Specialism Details

### <a name="specialism-governance-spend-authority"></a>governance-spend-authority

Storyboard category: `campaign_governance_*`. The agent holds a Plan and evaluates each binding against it.

Minimal decision logic:

```typescript
checkGovernance: async (params, ctx) => {
  const plan = await ctx.store.get('plan', params.plan_id);
  if (!plan) return adcpError('NOT_FOUND', { message: `Plan ${params.plan_id} not found` });

  const budget = params.binding.total_budget.amount;

  // 1. Human-review gate — GDPR Art 22 / EU AI Act.
  //    Every action on a human_review_required plan must be escalated, regardless of budget.
  //    Signal as `denied` + a critical-severity finding.
  //    The buyer resolves review off-protocol and re-calls check_governance with a fresh governance_context.
  if (plan.human_review_required) {
    return {
      check_id: `chk_${Date.now()}`,
      status: 'denied' as const,
      plan_id: params.plan_id,
      explanation: 'Plan requires human review before this action can proceed',
      findings: [{
        category_id: 'HUMAN_REVIEW_REQUIRED',
        severity: 'critical',
        explanation: 'plan.human_review_required is true — resolve off-protocol and retry with a fresh governance_context',
      }],
    };
  }

  // 2. Budget ceiling — cannot exceed plan.budget.total.
  if (budget > plan.budget.total) {
    return { check_id: `chk_${Date.now()}`, status: 'denied' as const, plan_id: params.plan_id,
      explanation: `Budget ${budget} exceeds plan ceiling ${plan.budget.total}`,
      findings: [{ category_id: 'BUDGET_EXCEEDED', severity: 'critical',
        explanation: `Over plan ceiling by ${budget - plan.budget.total}` }],
    };
  }

  // 3. Custom policy matching — custom_policies is an array of structured objects
  const conditions = [];
  for (const policy of plan.custom_policies ?? []) {
    if (policy.policy.toLowerCase().includes('ctv') && hasCtv(params.binding)) {
      conditions.push({ field: 'reporting.frequency', reason: policy.policy, policy_id: policy.policy_id });
    }
  }

  return {
    check_id: `chk_${Date.now()}`,
    status: conditions.length ? 'conditions' as const : 'approved' as const,   // 3-value enum, pick one
    plan_id: params.plan_id,
    explanation: conditions.length ? 'Approved with conditions' : 'Within spending authority',
    conditions,
    governance_context: `gov_ctx_${params.plan_id}_${Date.now()}`,  // opaque string — buyer echoes back to create_media_buy
  };
},
```

`governance_context` is an opaque string your agent mints and the buyer echoes back. Use it to tie a specific approval to a specific `create_media_buy` call — sign it or tag it with the plan revision if you care about tamper-resistance.

### <a name="specialism-governance-delivery-monitor"></a>governance-delivery-monitor

Storyboard: `governance_delivery_monitor`. Same `check_governance` tool, but the request carries `delivery_metrics` instead of a bare binding — that's the cue to run drift logic.

```typescript
checkGovernance: async (params, ctx) => {
  if (params.phase === 'delivery' || params.delivery_metrics) {
    const plan = await ctx.store.get('plan', params.plan_id);
    const reallocationThreshold = plan.budget.reallocation_threshold;   // absolute $, e.g. 8000

    // Check total-spend drift against the reallocation threshold
    const cumulative = params.delivery_metrics.cumulative_spend;
    const overage = cumulative - plan.budget.total;
    const exceeded = Math.abs(overage) > reallocationThreshold;

    // Also flag pacing mismatches that imply channel reallocation
    const driftedChannels = Object.entries(params.delivery_metrics.channel_distribution ?? {})
      .filter(([channel, percent]) => {
        const planAllocation = plan.channel_allocations?.[channel];
        return planAllocation != null && Math.abs(percent - planAllocation) > 10;   // 10pp threshold
      });

    if (!exceeded && driftedChannels.length === 0) {
      return { check_id: `chk_${Date.now()}`, status: 'approved' as const, plan_id: params.plan_id,
        explanation: 'Delivery within reallocation threshold',
        governance_context: params.governance_context ?? `gov_ctx_${params.plan_id}_delivery_approved` };
    }

    return {
      check_id: `chk_${Date.now()}`,
      status: 'conditions' as const,    // approved-with-reallocation — use the 'conditions' status, not 'approved'
      plan_id: params.plan_id,
      explanation: `Drift exceeded threshold: ${overage > 0 ? 'overage' : 'underage'} of ${Math.abs(overage)}`,
      conditions: driftedChannels.map(([channel, percent]) => ({
        field: `channel_distribution.${channel}`,
        reason: `Rebalance away from ${channel} — currently ${percent}%, plan targets ${plan.channel_allocations?.[channel] ?? 'unspecified'}%`,
      })),
      findings: [{ category_id: 'BUDGET_DRIFT_EXCEEDED', severity: 'warning',
        explanation: `Cumulative spend ${cumulative} outside reallocation threshold ±${reallocationThreshold}` }],
    };
  }
  // ... create-phase logic above
},

// Policy matching in create-phase checks — custom_policies is an array of objects, not strings:
for (const policy of plan.custom_policies ?? []) {
  if (policy.policy.toLowerCase().includes('ctv') && hasCtv(params.binding)) {
    conditions.push({ field: 'reporting.frequency', reason: policy.policy });
  }
}
```

The `findings[].category_id` / `severity: 'info' | 'warning' | 'critical'` enum is the schema-canonical shape per [adcontextprotocol/adcp#2286](https://github.com/adcontextprotocol/adcp/issues/2286). Storyboard validations today only check `field_present: findings`, so either spelling passes — but use the schema shape.

### <a name="specialism-property-lists"></a>property-lists

Storyboard: `property_lists`. Specialism and tool family share the same name. Your agent owns both inclusion and exclusion list semantics — track `list_type` on the stored list. Wrap identifiers with `selection_type: 'identifiers'`:

```typescript
createPropertyList: async (params, ctx) => {
  const list_id = `plist_${Date.now()}`;
  const stored = {
    list_id,
    name: params.name,
    description: params.description,
    list_type: 'inclusion' as const,        // caller-modeled — infer from context or add as ext
    base_properties: params.base_properties ?? [],    // each entry: { selection_type: 'identifiers', identifiers: [{ type, value }] }
    property_count: countIdentifiers(params.base_properties),
    status: 'active' as const,
  };
  await ctx.store.put('property_list', list_id, stored);
  return {
    list: summarize(stored),
    auth_token: `tok_${list_id}`,
  };
},

// Shape of a base_properties entry (matches the storyboard sample):
type BaseProperty = {
  selection_type: 'identifiers';
  identifiers: Array<{
    type: 'domain' | 'bundle_id' | 'app_store_url' | 'podcast_rss_feed' | 'property_rid';
    value: string;
  }>;
};
```

**`list_property_lists` / `list_collection_lists`** — destructure `ctx.store.list`. It returns `{ items, nextCursor? }`, never a bare array. Calling `.map` / `.filter` on the raw result throws `TypeError` and the dispatcher wraps it as `SERVICE_UNAVAILABLE`. Use the typed response helper so you can't accidentally ship a bare `[...]` at the top level (the storyboard runner flags that as shape drift):

```typescript
import { listPropertyListsResponse } from '@adcp/client/server';

listPropertyLists: async (params, ctx) => {
  const { items } = await ctx.store.list('property_list');
  return listPropertyListsResponse({
    lists: items.map(list => ({ list_id: list.list_id, name: list.name })),
  });
},
```

The same pattern applies to `list_collection_lists` (use `listCollectionListsResponse`) and `list_content_standards` (use `listContentStandardsResponse`). Both wrap the same `lists` / `standards` shape and guard against the bare-array drift at compile time.

`validate_property_delivery` returns `violations[]` with `list_id`, `list_type`, `severity: 'critical'`, and an explanation per non-compliant record — see the response shape in the tool section above.

The three mutating tools (`create_property_list`, `update_property_list`, `delete_property_list`) require `idempotency_key` per AdCP 3.0 GA — cache the response and return the same object on replay.

### <a name="specialism-collection-lists"></a>collection-lists

Storyboard: `collection_lists`. Where `property-lists` curate surfaces (domains, app bundle IDs), `collection-lists` curate **content programs** (shows, series, podcasts, series arcs) identified by platform-independent IDs: IMDb (`tt0944947`), Gracenote, EIDR. Program-level brand safety — "keep my ads out of all episodes of [show]" cuts across every surface that carries that show.

**Request shape** — `base_collections[]` wraps identifiers with a `selection_type`, and `filters` is an object (not an array):

```typescript
createCollectionList: async (params, ctx) => {
  const list_id = `clist_${Date.now()}`;
  const stored = {
    list_id,
    name: params.name,
    description: params.description,
    base_collections: params.base_collections ?? [],   // see shape below
    filters: params.filters ?? {},                     // object — e.g. { kinds: ['series'] }
    collection_count: resolveCollectionCount(params.base_collections, params.filters),
    status: 'active' as const,
  };
  await ctx.store.put('collection_list', list_id, stored);
  return { list: summarize(stored), auth_token: `tok_${list_id}` };
},

// Shape of a base_collections entry:
type BaseCollection = {
  selection_type: 'distribution_ids';
  identifiers: Array<{
    type: 'imdb_id' | 'gracenote_id' | 'eidr';
    value: string;                                     // e.g. "tt9999901"
  }>;
};

// Shape of filters:
type Filters = {
  kinds?: ('series' | 'movie' | 'podcast' | 'episode')[];
  // other filter families added in 3.1
};
```

**`get_collection_list`** with `resolve: true` returns the concrete `collections[]` (not `resolved_programs`) — the resolved list of program IDs after filters are applied. Sellers cache this at bid time.

```typescript
{
  list: {
    list_id: string,
    name: string,
    collection_count: number,
    collections: Array<{ type, value }>,     // resolved programs
    cache_valid_until: string,               // ISO timestamp — sellers respect this TTL
  },
}
```

No `validate_collection_delivery` tool exists yet (preview in 3.1). Delivery enforcement is a receiving-seller concern; the governance agent's job ends at publishing the resolved list with a `cache_valid_until`.

### <a name="specialism-content-standards"></a>content-standards

Storyboard: `content_standards`. Two load-bearing protocol shapes the baseline above does not cover:

1. **`policies` is an array of structured entries**, not a prose string. Each entry carries its own `enforcement` level — don't parse severity from inline `(must)` / `(should)` markers; read it off the `enforcement` field:

```typescript
type Policy = {
  policy_id: string;
  enforcement: 'must' | 'should';
  policy: string; // prose description of the rule
  policy_categories?: string[]; // e.g. ['brand_safety', 'imagery_quality']
  channels?: string[]; // e.g. ['display'] — scoped enforcement
};

function applies(p: Policy, artifact: { channel: string }): boolean {
  return !p.channels || p.channels.includes(artifact.channel);
}
```

2. **`validate_content_delivery` uses `records[].artifact`**, not `results[].creative_id`. See the tool section above for the full shape.

**Re-read policies per call.** The `standards_version_change` phase issues an update, then re-calibrates the same artifact and expects the new verdict. A memoized calibrator that caches by artifact_id will fail that phase. Always fetch the latest policies from `ctx.store.get('content_standards', standards_id)` inside `calibrate_content` / `validate_content_delivery`.

`calibrate_content` should return per-rule results, not just a top-level verdict:

```typescript
calibrateContent: async (params, ctx) => ({
  verdict: 'fail' as const,
  confidence: 0.95,
  explanation: 'Content violates tobacco-free rule',
  rules: [
    { rule: 'No tobacco advertising', severity: 'must', passed: false,
      evidence: 'Detected cigarette imagery in primary asset',
      remediation: 'Remove cigarette imagery or select a compliant creative' },
    { rule: 'Weekly pacing reports required for CTV', severity: 'should', passed: true,
      evidence: 'Agent has reporting_capabilities frequencies: ["weekly"]', remediation: null },
  ],
  features: [],
}),
```

## Reference

- `storyboards/campaign_governance_conditions.yaml` — conditional approval flow
- `storyboards/campaign_governance_denied.yaml` — denial flow
- `storyboards/property_lists.yaml` — property list lifecycle
- `storyboards/collection_lists.yaml` — collection list lifecycle
- `storyboards/content_standards.yaml` — content standards lifecycle
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
