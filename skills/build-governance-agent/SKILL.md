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
  status: 'approved',            // required — 'approved' | 'denied' | 'escalate'
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

## SDK Quick Reference

| SDK piece                                               | Usage                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `serve(createAgent)`                                    | Start HTTP server on `:3001/mcp`                                    |
| `createTaskCapableServer(name, version, { taskStore })` | Create MCP server with task support                                 |
| `server.tool(name, Schema.shape, handler)`              | Register tool — `.shape` unwraps Zod                                |
| `capabilitiesResponse(data)`                            | Build `get_adcp_capabilities` response                              |
| `taskToolResponse(data, summary)`                       | Build tool response (used for all governance tools)                 |
| `adcpError(code, { message })`                          | Structured error                                                    |

Schemas: `SyncPlansRequestSchema`, `CheckGovernanceRequestSchema`, `GetPlanAuditLogsRequestSchema`, `CreatePropertyListRequestSchema`, `GetPropertyListRequestSchema`, `UpdatePropertyListRequestSchema`, `ListPropertyListsRequestSchema`, `DeletePropertyListRequestSchema`, `ListContentStandardsRequestSchema`, `GetContentStandardsRequestSchema`, `CreateContentStandardsRequestSchema`, `UpdateContentStandardsRequestSchema`, `CalibrateContentRequestSchema`, `ValidateContentDeliveryRequestSchema`.

Import everything from `@adcp/client`. Types from `@adcp/client` with `import type`.

## Setup

```bash
npm init -y
npm install @adcp/client
```

## Implementation

1. Single `.ts` file — all tools in one file
2. Always register `get_adcp_capabilities` as the **first** tool with empty `{}` schema
3. Use `Schema.shape` (not `Schema`) when registering tools
4. For `validate_property_delivery`, use `{}` as the schema (no generated schema)
5. Set `sandbox: true` on all mock/demo responses
6. Use `ServeContext` pattern: `function createAgent({ taskStore }: ServeContext)`
7. Use in-memory Maps to store plans, property lists, and content standards

**Decision logic for check_governance:**

Route decisions based on the plan state and request parameters:
- Compare request budget against plan's `budget.total` and `authority_level`
- If `authority_level: 'agent_limited'` and buy exceeds threshold → deny
- If policy conditions match → approve with conditions
- If `phase: 'delivery'` → check delivery_metrics for drift

The skill contains everything you need. Do not read additional docs before writing code.

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
| Pass `Schema` instead of `Schema.shape`          | MCP SDK needs unwrapped Zod fields                                                       |
| Skip `get_adcp_capabilities`                     | Must be the first tool registered                                                        |
| `check_governance` missing `check_id`            | Generate a unique ID per check — required field                                          |
| `check_governance` returns `decision` not `status` | Field is `status`, not `decision`. Values: `approved`, `denied`, `escalate`            |
| Conditions use `description` instead of `reason`   | Condition schema requires `field` and `reason`, not `condition_id` and `description`  |
| Findings use `code`/`message` instead of proper fields | Finding schema requires `category_id`, `severity`, `explanation`                   |
| `sync_plans` response missing `version`          | Each plan needs `version: 1` (integer) — required field                                  |
| `delete_property_list` missing `deleted: true`   | Boolean `deleted` field is required in response                                          |
| `create_property_list` missing `auth_token`      | `auth_token` is required — generate a token string                                       |

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
- `docs/llms.txt` — full protocol reference
