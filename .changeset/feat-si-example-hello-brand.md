---
'@adcp/sdk': minor
---

feat(examples): hello_si_adapter_brand — worked SI adapter driving the SI mock through the v6 platform

Adds the SI reference adapter that wraps the upstream brand-agent
mock platform (`mock-server sponsored-intelligence`, #1441) and
exposes AdCP's four SI tools through the v6
`SponsoredIntelligencePlatform` shape (#1454).

Demonstrates the full upstream/AdCP rename gap an integrator faces
when wrapping a Salesforce Agentforce / OpenAI Assistants / custom
brand-chat platform: `conversation_id` ↔ `session_id`,
`assistant_message` ↔ `response.message`, `components.kind` ↔
`ui_elements.type`, `offering_query_id` ↔ `offering_token`,
`transaction_handoff` ↔ `acp_handoff`, `sku` ↔ `product_id`,
`hero_image_url` ↔ `image_url`, `pdp_url` ↔ `url`, and the loud
close-reason rename (`txn_ready` ↔ `handoff_transaction`, `done` ↔
`handoff_complete`, `user_left` ↔ `user_exit`, `idle_timeout` ↔
`session_timeout`, `host_closed` ↔ `host_terminated`).

Per-component-type projection — AdCP `SIUIElement.product_card`
requires `data.title` + `data.price`; upstream emits `name` +
`display_price`. The example projects per-type so wire validation
passes. The same gotcha applies to `action_button` (needs
`label` + `action`).

Eager close-hint projection: upstream `close_recommended.type:
'txn_ready'` becomes AdCP `session_status: 'pending_handoff'` +
`handoff: { type: 'transaction', intent: { action: 'purchase', product, price } }`
on the `si_send_message` response. The host then formally closes
via `si_terminate_session` to receive the ACP `acp_handoff`
payload.

**New SDK surface this example uses:**

- `defineSponsoredIntelligencePlatform<TCtxMeta>` — type-level
  identity helper, parallel to `defineSignalsPlatform` /
  `defineCreativeBuilderPlatform`. Exported from
  `@adcp/sdk/server`.

**Bug fix in `RequiredPlatformsFor<S>`** that this example surfaced:
the fall-through used `Record<string, never>` (rejects any platform
with handler fields). Distributive conditional over an empty union
also collapsed to `never`. Both branches now resolve to `{}` (the
empty-requirements identity, sister-to `RequiredCapabilitiesFor`'s
fall-through). Adopters with empty `specialisms: []` (legitimate
when the agent's only declared surface is a *protocol*, like SI
pre-3.1) now get a working type. Documented inline at the
fall-through with reasoning.

**Tests** — `test/examples/hello-si-adapter-brand.test.js`. SI is
preview-only (no compliance storyboard yet), so the test rolls its
own runtime gates rather than using the shared three-gate helper:

1. **Strict tsc** — `--strict --noUncheckedIndexedAccess
   --exactOptionalPropertyTypes
   --noPropertyAccessFromIndexSignature`. Parallel to peer
   adapter tests.
2. **End-to-end MCP smoke** — boots mock + adapter, drives all
   four SI tools through the MCP wire (`StreamableHTTPClientTransport`
   + `Client.callTool`), verifies upstream→AdCP renames project
   correctly (offering_query_id round-trip, conversation_id →
   session_id, transaction_handoff → acp_handoff, txn_ready →
   pending_handoff projection on send_message).
3. **Façade gate** — every expected upstream route shows ≥1 hit
   at `/_debug/traffic`. (`/_lookup/brand` excluded — SI tool
   schemas don't carry `account` on the wire, so
   `accounts.resolve(undefined)` falls back to
   `DEFAULT_LISTING_BRAND` without exercising lookup. That route
   fires only on production paths binding `account.brand.domain`
   from `ctx.authInfo`.)

6 tests, all passing.

Run the demo:

```bash
npx @adcp/sdk@latest mock-server sponsored-intelligence --port 4504
UPSTREAM_URL=http://127.0.0.1:4504 \
  npx tsx examples/hello_si_adapter_brand.ts
curl http://127.0.0.1:4504/_debug/traffic
```

Refs adcontextprotocol/adcp#3961, #1441, #1454.
