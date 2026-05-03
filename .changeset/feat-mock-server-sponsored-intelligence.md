---
'@adcp/sdk': minor
---

feat(cli+harness): `adcp mock-server sponsored-intelligence` — fifth specialism (brand-agent platform shape)

Adds the SI mock-server. Brand-agent-platform-shaped upstream (Salesforce
Agentforce / OpenAI Assistants / custom-brand-chat family) that hosts
conversational brand offerings and exposes them via a stateful HTTP API.
Adapter wraps it to project AdCP `si_get_offering`, `si_initiate_session`,
`si_send_message`, `si_terminate_session`.

This is the first matrix-v2 fixture for SI. Lets adopters dogfood SI ahead
of `adcontextprotocol.org` standing up a reference SI tenant — and lets
the SDK exercise the four SI tools end-to-end against a deterministic
fixture.

**Why a mock now (and not a v6 platform shape):** SI is currently a
*protocol* in AdCP 3.0 (`supported_protocols: ['sponsored_intelligence']`)
but not a *specialism* — `sponsored-intelligence` is absent from
`AdCPSpecialism`. That blocks a v6 `SponsoredIntelligencePlatform`
interface with parity to the other specialism platforms; adopters wire SI
through the v5 `createAdcpServer` handler bag
(`SponsoredIntelligenceHandlers`). The mock server is independent of that
decision — it represents the upstream brand platform an adapter wraps,
regardless of which SDK shape the AdCP-side handler uses. Filed as
adcontextprotocol/adcp#3961.

**Routes** (path-scoped multi-tenancy, parallel to creative-template):

- `GET /_lookup/brand?adcp_brand=<value>` — discovery (no auth)
- `GET /_debug/traffic` — façade-detection traffic counters
- `GET /v1/brands/{brand}/offerings/{offering_id}` — `si_get_offering`
- `POST /v1/brands/{brand}/conversations` — `si_initiate_session`
- `GET /v1/brands/{brand}/conversations/{conv_id}` — read state
- `POST /v1/brands/{brand}/conversations/{conv_id}/turns` — `si_send_message`
- `POST /v1/brands/{brand}/conversations/{conv_id}/close` — `si_terminate_session`

Conversation lifecycle: `active` → `closed` (terminal). Re-closing
returns the same payload — naturally idempotent on `conversation_id`,
mirroring AdCP's decision to omit `idempotency_key` on
`si_terminate_session`. POST `/conversations` and POST `/turns` each
accept `client_request_id` (the upstream-side translation of AdCP
`idempotency_key`) for at-most-once execution; mismatched body with
reused key → `409 idempotency_conflict`.

**Brand-agent canned responses** (deterministic, keyword-routed):

- `buy` / `purchase` / `checkout` / `order` → response with
  `close_recommended: { type: 'transaction', payload }` — adapter
  surfaces as AdCP `session_status: 'pending_handoff'` + populated
  `handoff` block.
- `thanks` / `bye` / `done` → `close_recommended: { type: 'complete' }`
- `second` / `next` / `other one` → swap product card to next product
- otherwise → product card from the configured offering

When `close` is called with `reason=transaction`, the response includes
a `transaction_handoff` block with `checkout_url`, `checkout_token`, and
`expires_at` — adapter projects to AdCP `acp_handoff` on
`SITerminateSessionResponse`.

**Two seeded brands** (multi-tenancy assertion): `brand_acme_outdoor`
(running shoes, single offering with two products) and
`brand_summit_books` (independent bookstore, single offering with one
product). Cross-brand offering access returns
`404 offering_not_in_brand`.

**Upstream/AdCP rename pattern** is intentional throughout (exercises
the adapter's projection): `conversation_id` → `session_id`,
`assistant_message` → `response.message`, `components` (with `kind`) →
`ui_elements` (with `type`), `sku` → `product_id`, `hero_image_url` →
`image_url`, `landing_page_url` → `landing_url`, `pdp_url` → `url`,
`thumbnail_url` → `image_url`, `inventory_status` →
`availability_summary`, `transaction_handoff` → `acp_handoff`.

Run with:

```bash
npx @adcp/sdk mock-server sponsored-intelligence --port 4500
```

**16 new smoke tests** in
`test/lib/mock-server/sponsored-intelligence.test.js` cover:
auth gating, brand lookup, cross-brand offering isolation, conversation
start with idempotent replay, turn keyword routing (transaction/complete
hints), idempotency-conflict rejection, transaction close with handoff
payload, idempotent re-close, post-close turn rejection, and traffic
counter recording.

Refs adcontextprotocol/adcp#3961.
