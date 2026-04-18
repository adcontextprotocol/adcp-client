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

Evaluate a media buy against the registered plan. The response needs `check_id`, `status`, `plan_id`, and `explanation`.

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

```
taskToolResponse({
  compliant: true,              // required — overall compliance
  results: [{
    property: string,
    compliant: boolean,
  }],
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

```
taskToolResponse({
  standards_id: string,
  name: string,
  policy: [{
    category: string,
    description: string,
    severity: 'info' | 'warning' | 'critical',
  }],
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

```
taskToolResponse({
  summary: {
    compliant: true,
    total_impressions: number,
    non_compliant_impressions: 0,
  },
  results: [{
    creative_id: string,
    compliant: boolean,
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
serve(createAgent, {
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: 'https://my-agent.example.com/mcp', // MUST match the URL clients call
  }),
  protectedResource: { authorization_servers: ['https://auth.example.com'] },
});

// Both
serve(createAgent, {
  authenticate: anyOf(verifyApiKey({ verify: lookupKey }), verifyBearer({ jwksUri, issuer, audience })),
  protectedResource: { authorization_servers: [issuer] },
});
```

The framework produces RFC 6750-compliant `WWW-Authenticate: Bearer` 401s on failure, and serves `/.well-known/oauth-protected-resource<mountPath>` with the correct `resource` URL (auto-derived from the request host so buyers get tokens bound to the right audience).


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

## Reference

- `storyboards/campaign_governance_conditions.yaml` — conditional approval flow
- `storyboards/campaign_governance_denied.yaml` — denial flow
- `storyboards/property_governance.yaml` — property list lifecycle
- `storyboards/content_standards.yaml` — content standards lifecycle
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
