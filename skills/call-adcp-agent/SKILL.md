---
name: call-adcp-agent
description: Use when calling an AdCP agent as a buyer — media buys, signal lookups, creative sync, delivery reports. Covers the wire contract, common payload shapes, async flow, and error recovery so you don't get stuck on oneOf or discriminated-union fields that schema-free tool discovery won't explain.
---

# Call an AdCP agent

## When to Use

- User wants to call a publisher / SSP / retail media network over AdCP
- Tool names like `get_products`, `create_media_buy`, `sync_creatives`, `get_signals` appear in the available-tools list
- Agent card advertises `protocolVersion: '0.3.0'` with `skills` listing AdCP tool names
- **Not this skill:** building an AdCP seller agent (see `skills/build-seller-agent/`)

## Discovery chain

Walk these in order on first contact:

1. **Agent card** (A2A) or **`tools/list`** (MCP): returns tool NAMES. Post-`@adcp/client` [#915](https://github.com/adcontextprotocol/adcp-client/pull/915), `tools/list` no longer publishes per-tool parameter schemas — everything shows `{type: 'object', properties: {}}`. Don't try to infer shape from here.
2. **`get_adcp_capabilities`**: returns supported protocols (`media_buy`, `signals`, `creative`, …), AdCP major versions, feature flags. Tells you WHICH tools this agent supports, not how to call them.
3. **`get_schema(tool_name)`** *(when the agent exposes it — upstream [adcp#3057](https://github.com/adcontextprotocol/adcp/issues/3057))*: returns the JSON Schema for a tool's request/response. Preferred over reading bundled schemas when available.
4. **Bundled schemas** (offline, authoritative): `schemas/cache/<version>/bundled/<protocol>/<tool>-request.json` and `-response.json`. The spec ships them; every AdCP version has them.

## Non-obvious rules every buyer must follow

### `idempotency_key` is required on every mutating tool

UUID format. Same key on retry → replay cached response. Required on: `create_media_buy`, `update_media_buy`, `sync_creatives`, `sync_audiences`, `sync_accounts`, `sync_catalogs`, `sync_event_sources`, `sync_plans`, `sync_governance`, `activate_signal`, `acquire_rights`, `log_event`, `report_usage`, `provide_performance_feedback`, `report_plan_outcome`, `create_property_list`, `update_property_list`, `delete_property_list`, `create_collection_list`, `update_collection_list`, `delete_collection_list`, `create_content_standards`, `update_content_standards`, `calibrate_content`, `si_initiate_session`, `si_send_message`.

Missing the key → `adcp_error.code: 'VALIDATION_ERROR'` with `/idempotency_key` in `issues`.

### `account` is a `oneOf` — pick ONE variant, send ONLY its fields

Probably the single most common stumble for naive LLMs. `account` is a discriminated union. Per AdCP 3.0, two variants on `create_media_buy` / `update_media_buy`:

```json
// variant 0: by seller-assigned id (from sync_accounts or list_accounts)
"account": { "account_id": "seller_assigned_id" }

// variant 1: by natural key (brand + operator, optional sandbox)
"account": { "brand": { "domain": "acme.com" }, "operator": "sales.example" }
```

**Do NOT merge required fields across variants** — `additionalProperties: false` on each variant means `{account_id, brand}` fails BOTH. Pick one variant and send only its fields. Always check the specific tool's schema because other tools (e.g. `sync_creatives`) may accept a superset.

### `brand` takes `{domain}` — not `{brand_id}`

```json
"brand": { "domain": "acme.example" }
```

### Async responses: `status: 'submitted'` means "queued, poll later"

A mutating tool can return one of three shapes:

```json
// Success (sync): the work is done
{ "media_buy_id": "mb_123", "packages": [...], "confirmed_at": "..." }

// Submitted (async): the work is queued
{ "status": "submitted", "task_id": "tk_abc", "message": "Awaiting IO signature" }

// Error: don't retry without fixing
{ "errors": [{ "code": "PRODUCT_NOT_FOUND", "message": "..." }] }
```

When you see `status: 'submitted'`, the work is NOT complete. Poll via `tasks/get` (A2A) or the MCP async task extension, using the `task_id`. Over A2A the AdCP `task_id` also rides on `artifact.metadata.adcp_task_id` — both work.

### `packages[*]` on media buys

```json
"packages": [
  { "buyer_ref": "pkg_1", "product_id": "p_from_catalog", "budget": 10000, "pricing_option_id": "po_xyz" }
]
```

`budget` is a **number** (not `{amount, currency}` — currency is implied by the pricing option). `pricing_option_id` and `buyer_ref` are required per package.

## Error envelope — read `issues[]` to recover

Every validation failure produces:

```json
{
  "adcp_error": {
    "code": "VALIDATION_ERROR",
    "recovery": "correctable",
    "field": "/first/offending/pointer",
    "issues": [
      { "pointer": "/account",    "keyword": "oneOf", "message": "must match exactly one schema in oneOf" },
      { "pointer": "/brand/domain", "keyword": "required", "message": "must have required property 'domain'" }
    ]
  }
}
```

- `issues[].pointer` is an RFC 6901 JSON Pointer to the field.
- `issues[].keyword` is the AJV keyword (`required`, `type`, `oneOf`, `additionalProperties`, `format`, `enum`).
- **On `oneOf` errors** the framework tells you the field is a union but NOT which variant to pick. This skill or the schema is how you know.

Patch the pointers, don't re-guess what the skill already told you, resend. Three attempts should cover every field.

## Minimal working examples

### get_products

```json
{
  "buying_mode": "brief",
  "brief": "premium CTV sports inventory for live NBA finals in major US markets"
}
```

Returns `{ products: [{ product_id, name, description, delivery_type, pricing_options, ... }] }`.

### create_media_buy

```json
{
  "idempotency_key": "<uuid>",
  "account": { "account_id": "seller_assigned_id" },
  "brand": { "domain": "acme.example" },
  "start_time": "2026-05-01T00:00:00Z",
  "end_time": "2026-05-31T23:59:59Z",
  "packages": [
    {
      "buyer_ref": "pkg_1",
      "product_id": "<product_id from get_products>",
      "budget": 10000,
      "pricing_option_id": "<pricing_option_id from product.pricing_options>"
    }
  ]
}
```

If you don't have a `seller_assigned_id`, use the natural-key variant instead:
`"account": { "brand": { "domain": "acme.example" }, "operator": "sales.example" }`.

Returns **either** `{ media_buy_id, packages: [...], confirmed_at }` (sync) **or** `{ status: 'submitted', task_id, message }` (async — guaranteed / IO-signed flows).

### sync_creatives

```json
{
  "idempotency_key": "<uuid>",
  "account": { "account_id": "seller_assigned_id" },
  "creatives": [
    {
      "creative_id": "cr_1",
      "name": "My Creative",
      "format_id": { "agent_url": "https://creatives.adcontextprotocol.org", "id": "video_1920x1080" },
      "assets": {}
    }
  ]
}
```

Per-creative required: `creative_id`, `name`, `format_id: { agent_url, id }`, `assets` (shape depends on `format_id`; start with `{}` then fill required asset keys per format spec). Returns `{ creatives: [{ creative_id, action, status }] }` — items may fail individually without failing the batch.

### get_signals

```json
{
  "signal_spec": "female professionals 25-54 in major US metros"
}
```

Returns `{ signals: [{ signal_agent_segment_id, match_rate, pricing, ... }] }`. Note: the identifier field is `signal_agent_segment_id` (not `signal_id`) — used as input to `activate_signal` below.

### activate_signal

```json
{
  "idempotency_key": "<uuid>",
  "signal_agent_segment_id": "sig_premium_ctv_sports",
  "destinations": [
    { "type": "platform", "platform": "trade_desk_us" }
  ]
}
```

`destinations[]` is a `oneOf`: either `{type: 'platform', platform, account?}` OR `{type, agent_url, account?}`. Pick one shape per destination.

## Transport notes

- **MCP**: `tools/call` with `{ name: 'tool_name', arguments: {...} }`. Returns `{ content, structuredContent, isError? }`. Read `structuredContent` for the typed response.
- **A2A**: `message/send` with a `DataPart` of shape `{ skill: 'tool_name', input: {...} }` (the legacy key `parameters` is also accepted). Returns an A2A `Task`; the typed response is at `task.artifacts[0].parts[0].data`.

Both transports share: idempotency, error shape, schema enforcement, and handler semantics. If a call works on one, the equivalent call works on the other.

## Gotchas I keep seeing

1. **Merging `oneOf` variants**: see the account section above. If you see three `additionalProperties` errors under one pointer, you merged. Drop to one variant.
2. **`budget` as an object**: it's a number. Currency comes from the `pricing_option`.
3. **`brand.brand_id` instead of `brand.domain`**: spec uses `domain`.
4. **Forgetting `idempotency_key`**: required on every mutating tool; see the list above.
5. **Treating A2A `Task.state: 'completed'` as AdCP completion**: A2A task state = transport call lifecycle. AdCP-level completion is in the artifact's payload (`structuredContent.status` or `data.status`). A `completed` A2A task can still carry a `submitted` AdCP response.

## If you get stuck

Priority order:

1. Re-read the failure's `issues[]`. The pointer list plus this skill covers 80% of cases.
2. Call `get_schema(tool_name)` if the agent exposes it (adcp#3057).
3. Read the bundled JSON Schema at `schemas/cache/<version>/bundled/<protocol>/<tool>-request.json`.
4. Consult `docs/guides/VALIDATE-YOUR-AGENT.md` in `@adcp/client` for per-specialism patterns.

## Related

- `skills/build-seller-agent/SKILL.md` — building agents on the other side of the call
- `docs/guides/BUILD-AN-AGENT.md` — framework reference
- `schemas/cache/<version>/` — canonical JSON Schemas (every tool, every version)
