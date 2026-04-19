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

| Specialism | Status | Delta from baseline | See |
|---|---|---|---|
| `governance-spend-authority` | stable | `check_governance` evaluates `binding` against Plan's `authority_level` + `custom_policies`; return conditions or denial | [§ governance-spend-authority](#specialism-governance-spend-authority) |
| `governance-delivery-monitor` | stable | `check_governance` with `phase: 'delivery'` + `delivery_evidence`; compute drift vs Plan's `reallocation_threshold`; return `BUDGET_DRIFT_EXCEEDED` findings | [§ governance-delivery-monitor](#specialism-governance-delivery-monitor) |
| `inventory-lists` | stable | Tool family is named `property_list` — specialism title aside; implement CRUD plus `validate_property_delivery` with full `violations[]` | [§ inventory-lists](#specialism-inventory-lists) |
| `audience-sync` | stable | **Does not use governance tools.** Required: `sync_audiences` + `list_accounts`. Handlers live under `accounts` / `eventTracking` domain groups, not `governance`. | [§ audience-sync](#specialism-audience-sync) |
| `content-standards` | stable | `policy` on create/update is a **prose string** with inline `(must)`/`(should)` severity — not the array shape shown in the baseline below; `validate_content_delivery` uses `records[].artifact`, not `results[].creative_id` | [§ content-standards](#specialism-content-standards) |
| `measurement-verification` | preview | v3.1 placeholder (empty `phases`). Pass universal + governance baseline only. Advertise `measurement_verification` capability for discoverability. | Baseline only |

Specialism ID (kebab-case) = storyboard directory. Storyboard `id:` (snake_case, e.g. `campaign_governance_conditions`) is the category name — multiple specialisms can reference the same storyboard category.

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
  plan_id: string,              // required — previously registered via sync_plans
  phase: 'create' | 'delivery', // required — gating create_media_buy vs monitoring active flight
  binding: {                    // what to evaluate
    type: 'media_buy',
    account: { brand: {...}, operator: string },
    total_budget: { amount: number, currency: string },
    packages: [{ product_id, pricing_option_id, budget }],
  },
  delivery_evidence?: {         // only on phase: 'delivery'
    packages: [{ package_id, budget, spend_to_date, flight_progress }],
  },
  governance_context?: string,  // prior check's context, for re-evaluation
}
```

The Plan object (stored via `sync_plans`) drives decisions. Expected shape:

```
{
  plan_id: string,
  brand: { domain: string },
  operator: string,
  budget: { total: number, currency: string },
  authority_level: 'agent_full' | 'agent_limited' | 'human_required',
  custom_policies: string[],        // free-form rules, e.g. "CTV buys require weekly delivery reporting (must)"
  reallocation_threshold: number,   // drift % that triggers re-approval during delivery
}
```

The response needs `check_id`, `status`, `plan_id`, and `explanation`.

```
// Approved:
taskToolResponse({
  check_id: string,              // required — unique check identifier
  status: 'approved',            // required — 'approved' | 'denied' | 'conditions'
  plan_id: string,               // required — echo from request
  explanation: string,           // required — human-readable explanation
  governance_context: string,    // pass to create_media_buy
})

// Approved with conditions:
taskToolResponse({
  check_id: string,
  status: 'approved',
  plan_id: string,
  explanation: 'Approved with conditions',
  conditions: [{                 // array of binding conditions
    field: string,               // required — what the condition applies to
    reason: string,              // required — why the condition exists
    required_value: string,      // optional — specific value required
  }],
  governance_context: string,
})

// Denied:
taskToolResponse({
  check_id: string,
  status: 'denied',
  plan_id: string,
  explanation: 'Exceeds spending authority',
  findings: [{                   // array of policy findings
    category_id: string,         // required — policy category ID
    severity: 'info' | 'warning' | 'critical', // required
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

`policy` is a free-text string with embedded `(must)` and `(should)` severity markers. Parse them at check time — `(must)` is blocking, `(should)` is advisory. Do not model as a structured array; the storyboard sends prose.

```
taskToolResponse({
  standards_id: string,
  name: string,
  policy: 'No tobacco advertising on family-programming properties (must). Weekly pacing reports required for CTV buys (should).',
  scope: { languages_any: ['en', 'es'], brand: { domain: string } },
})
```

**`update_content_standards`** — `UpdateContentStandardsRequestSchema.shape`

```
taskToolResponse({
  success: true,
  standards_id: string,
})
```

**`calibrate_content`** — `CalibrateContentRequestSchema.shape`

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
    artifact: { artifact_id: string, assets: {...} },
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
    artifact: { artifact_id: string, assets: {...} },
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

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `sync_governance`.

## SDK Quick Reference

| SDK piece                                  | Usage                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `createAdcpServer({ name, governance })` | Create server with domain-grouped handlers and auto-generated capabilities |
| `serve(() => createAdcpServer(...))`       | Start HTTP server on `:3001/mcp`                                        |
| `ctx.store`                                | State persistence — `get/put/patch/delete/list` domain objects          |
| `adcpError(code, { message })`             | Structured error                                                        |

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

serve(() => createAdcpServer({
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
}));
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
  backend: memoryBackend(),         // or pgBackend(pool) for production
  ttlSeconds: 86400,                // 3600–604800 per spec; throws if out of range
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
    verify: async (token) => {
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

The framework produces RFC 6750-compliant `WWW-Authenticate: Bearer` 401s on failure, and serves `/.well-known/oauth-protected-resource<mountPath>` with `publicUrl` as the `resource` field so buyers get tokens bound to the right audience. The default JWT allowlist is asymmetric-only (RS*/ES*/PS*/EdDSA) to prevent algorithm-confusion attacks.


## Validation

**After writing the agent, validate it. Fix failures. Repeat.**

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp campaign_governance_conditions --json
npx @adcp/client storyboard run http://localhost:3001/mcp campaign_governance_denied --json
npx @adcp/client storyboard run http://localhost:3001/mcp property_governance --json
npx @adcp/client storyboard run http://localhost:3001/mcp content_standards --json
```

**Keep iterating until all steps pass.**

## Common Mistakes

| Mistake                                          | Fix                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Manually registering `get_adcp_capabilities`     | Framework auto-generates it from registered handlers — do not register it yourself        |
| Using `server.tool()` instead of domain groups   | Use `governance: { syncPlans, checkGovernance, ... }` — framework wires schemas and response builders |
| Using in-memory Maps for state                   | Use `ctx.store.put/get/patch/delete/list` — built-in state persistence                   |
| `check_governance` missing `check_id`            | Generate a unique ID per check — required field                                          |
| `check_governance` returns `decision` not `status` | Field is `status`, not `decision`. Values: `approved`, `denied`, `conditions`          |
| Conditions use `description` instead of `reason`   | Condition schema requires `field` and `reason`, not `condition_id` and `description`  |
| Findings use `code`/`message` instead of proper fields | Finding schema requires `category_id`, `severity`, `explanation`                   |
| `sync_plans` response missing `version`          | Each plan needs `version: 1` (integer) — required field                                  |
| `delete_property_list` missing `deleted: true`   | Boolean `deleted` field is required in response                                          |
| `create_property_list` missing `auth_token`      | `auth_token` is required — generate a token string                                       |
| Dropping `context` from responses              | Echo `args.context` back unchanged in every response — buyers use it for correlation |

## Storyboards

| Storyboard                        | Tests                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| `campaign_governance_conditions`  | Approved with conditions flow                                  |
| `campaign_governance_delivery`    | Delivery monitoring with drift re-evaluation                   |
| `campaign_governance_denied`      | Denied — buy exceeds spending authority                        |
| `property_governance`             | Property list lifecycle: create, query, update, delete, validate |
| `content_standards`               | Content standards lifecycle: create, calibrate, validate       |

## Specialism Details

### <a name="specialism-governance-spend-authority"></a>governance-spend-authority

Storyboard category: `campaign_governance_*`. The agent holds a Plan and evaluates each binding against it.

Minimal decision logic:

```typescript
checkGovernance: async (params, ctx) => {
  const plan = await ctx.store.get('plan', params.plan_id);
  if (!plan) return adcpError('NOT_FOUND', { message: `Plan ${params.plan_id} not found` });

  const budget = params.binding.total_budget.amount;

  // 1. Authority level gate
  if (plan.authority_level === 'human_required') {
    return { check_id: `chk_${Date.now()}`, status: 'escalate' as const, plan_id: params.plan_id,
      explanation: 'Requires human approval' };
  }
  if (plan.authority_level === 'agent_limited' && budget > plan.budget.total) {
    return { check_id: `chk_${Date.now()}`, status: 'denied' as const, plan_id: params.plan_id,
      explanation: `Budget ${budget} exceeds authority limit ${plan.budget.total}`,
      findings: [{ category_id: 'BUDGET_EXCEEDED', severity: 'critical',
        explanation: `Over authority by ${budget - plan.budget.total}` }],
    };
  }

  // 2. Custom policy matching (free-form strings)
  const conditions = [];
  for (const policy of plan.custom_policies ?? []) {
    if (policy.toLowerCase().includes('ctv') && hasCtv(params.binding)) {
      conditions.push({ field: 'reporting.frequency', reason: policy });
    }
  }

  return {
    check_id: `chk_${Date.now()}`,
    status: 'approved' as const,
    plan_id: params.plan_id,
    explanation: conditions.length ? 'Approved with conditions' : 'Within spending authority',
    conditions,
    governance_context: `gov_ctx_${params.plan_id}_${Date.now()}`,  // opaque string — buyer echoes back to create_media_buy
  };
},
```

`governance_context` is an opaque string your agent mints and the buyer echoes back. Use it to tie a specific approval to a specific `create_media_buy` call — sign it or tag it with the plan revision if you care about tamper-resistance.

### <a name="specialism-governance-delivery-monitor"></a>governance-delivery-monitor

Storyboard category: `campaign_governance_delivery`. Same `check_governance` tool, different `phase` and payload.

```typescript
checkGovernance: async (params, ctx) => {
  if (params.phase === 'delivery') {
    const plan = await ctx.store.get('plan', params.plan_id);
    const threshold = plan.reallocation_threshold ?? 0.15;  // e.g. 15% drift

    const driftedPackages = [];
    for (const pkg of params.delivery_evidence?.packages ?? []) {
      const expected = pkg.budget * pkg.flight_progress;     // what should have spent by now
      const actual = pkg.spend_to_date;
      const drift = Math.abs(actual - expected) / pkg.budget;
      if (drift > threshold) driftedPackages.push({ ...pkg, drift });
    }

    if (driftedPackages.length === 0) {
      return { check_id: `chk_${Date.now()}`, status: 'approved' as const, plan_id: params.plan_id,
        explanation: 'Delivery within threshold',
        governance_context: params.governance_context ?? `gov_ctx_${params.plan_id}_delivery` };
    }

    return {
      check_id: `chk_${Date.now()}`,
      status: 'approved' as const,    // approved with reallocation conditions
      plan_id: params.plan_id,
      explanation: `Drift exceeded ${threshold * 100}% on ${driftedPackages.length} package(s)`,
      conditions: driftedPackages.map((pkg) => ({
        field: `packages[${pkg.package_id}].budget`,
        reason: `Reallocate to match delivered pace (drift ${(pkg.drift * 100).toFixed(1)}%)`,
      })),
      findings: [{ category_id: 'BUDGET_DRIFT_EXCEEDED', severity: 'warning',
        explanation: `${driftedPackages.length} package(s) outside reallocation threshold` }],
    };
  }
  // ... create-phase logic above
},
```

If the storyboard's `findings` shape (using `code`, `severity: 'should'`) diverges from the schema's (`category_id`, `severity: 'info'|'warning'|'critical'`), trust the schema — file an issue against adcp spec to reconcile. Current skill guidance uses `category_id`/`severity`.

### <a name="specialism-inventory-lists"></a>inventory-lists

Storyboard category: `property_governance`. The specialism is named `inventory-lists` but the tool family is `property_list`. Your agent owns both inclusion and exclusion list semantics — track `list_type` on the stored list even though the request schema may not surface it.

```typescript
createPropertyList: async (params, ctx) => {
  const list_id = `plist_${Date.now()}`;
  const stored = {
    list_id,
    name: params.name,
    description: params.description,
    list_type: 'inclusion' as const,        // caller-modeled — infer from context or add as ext
    base_properties: params.base_properties ?? [],
    property_count: countIdentifiers(params.base_properties),
    status: 'active' as const,
  };
  await ctx.store.put('property_list', list_id, stored);
  return {
    list: summarize(stored),
    auth_token: `tok_${list_id}`,
  };
},
```

`validate_property_delivery` returns `violations[]` with `list_id`, `list_type`, `severity: 'critical'`, and an explanation per non-compliant record — see the response shape in the tool section above.

### <a name="specialism-audience-sync"></a>audience-sync

Storyboard: `audience_sync`. The specialism is classified under `domain: governance`, but its `required_tools` (`sync_audiences`, `list_accounts`) live outside this skill's `governance` handler group. Wire them under `accounts` and `eventTracking`:

```typescript
createAdcpServer({
  accounts: {
    syncAccounts: /* ... */,
    listAccounts: async (params, ctx) => {
      const { items } = await ctx.store.list('accounts');
      const brandFilter = params.brand?.domain;
      return { accounts: brandFilter ? items.filter((a) => a.brand.domain === brandFilter) : items };
    },
  },
  eventTracking: {
    syncAudiences: async (params, ctx) => ({
      audiences: params.audiences.map((a) => ({
        audience_id: a.audience_id,
        name: a.name,
        status: 'active' as const,
        action: a.delete ? 'deleted' : 'created',  // empty audiences array = discovery mode
        uploaded_count: a.members?.length ?? 0,
        matched_count: Math.floor((a.members?.length ?? 0) * 0.72),   // simulated match rate
        effective_match_rate: 0.72,
      })),
    }),
  },
  governance: { /* baseline */ },
});
```

Identifier rules: hashed emails/phones use SHA-256 on lowercased, trimmed input. Salting/normalization is out-of-band between buyer and platform.

Destinations span `platform_types: ['dsp', 'retail_media', 'social', 'audio', 'pmax']`. Each has its own `activation_key` shape — see `skills/build-signals-agent/SKILL.md` for the activation patterns.

### <a name="specialism-content-standards"></a>content-standards

Storyboard: `content_standards`. Two load-bearing protocol quirks the baseline above does not cover:

1. **`policy` is a prose string**, not a structured array. Parse `(must)` vs `(should)` at check time:

```typescript
function severityFor(rule: string): 'must' | 'should' {
  return /\(must\)/i.test(rule) ? 'must' : 'should';
}

// Splitting a policy into rules:
const rules = policy.split(/\.\s+/).filter(Boolean);   // sentence-per-rule convention
```

2. **`validate_content_delivery` uses `records[].artifact`**, not `results[].creative_id`. See the tool section above for the full shape.

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
- `storyboards/property_governance.yaml` — property list lifecycle
- `storyboards/content_standards.yaml` — content standards lifecycle
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
