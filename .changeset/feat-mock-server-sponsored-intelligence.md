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
the adapter's projection):

| upstream field | AdCP field |
|---|---|
| `conversation_id` | `session_id` |
| `assistant_message` | `response.message` |
| `components[].kind` | `ui_elements[].type` |
| `client_request_id` | `idempotency_key` |
| `offering_query_id` | `offering_token` |
| `transaction_handoff` | `acp_handoff` |
| `close_recommended.type: txn_ready` | `session_status: 'pending_handoff'` + `handoff.type: 'transaction'` |
| `close_recommended.type: done` | `session_status: 'pending_handoff'` + `handoff.type: 'complete'` |
| `close.reason: txn_ready` | `SITerminateSessionRequest.reason: 'handoff_transaction'` |
| `close.reason: done` | `'handoff_complete'` |
| `close.reason: user_left` | `'user_exit'` |
| `close.reason: idle_timeout` | `'session_timeout'` |
| `close.reason: host_closed` | `'host_terminated'` |
| `sku` | `product_id` |
| `hero_image_url`, `thumbnail_url` | `image_url` |
| `landing_page_url` | `landing_url` |
| `pdp_url` | `url` |
| `inventory_status` | `availability_summary` |

The close-reason vocabulary is deliberately distinct from AdCP's enum
(rather than identity-mapping `complete` to `complete`) so the adapter's
translation is loud — sending an AdCP reason value to the upstream close
endpoint returns `400 invalid_close_reason`, forcing the adapter to
implement the projection rather than accidentally pass-through.

**Offering token correlation** (`offering_query_id`): the brand mints a
token on every `GET /offerings/{id}` and stores the products-shown
record keyed on it. A subsequent `POST /conversations` with the same
token resolves "the second one" against what the user actually saw,
not the full catalog. Mirrors the AdCP `SIGetOfferingResponse.offering_token`
→ `SIInitiateSessionRequest.offering_token` correlation primitive.

Run with:

```bash
npx @adcp/sdk mock-server sponsored-intelligence --port 4500
```

**23 smoke tests** in
`test/lib/mock-server/sponsored-intelligence.test.js` cover: auth
gating, brand lookup, cross-brand offering and conversation isolation,
conversation start with idempotent replay and idempotency-conflict
rejection (POST /conversations and POST /turns symmetric), turn keyword
routing (txn_ready/done close hints), close with txn_ready returning a
transaction_handoff, AdCP-vocabulary reason rejection (400
`invalid_close_reason`), idempotent re-close, post-close turn
rejection, GET-after-close, offering_query_id round-trip from GET
/offerings into POST /conversations, unknown-token rejection, cross-brand
token rejection, and traffic counter recording.

**Deferred to follow-up branches** (acknowledged limitations of this v1
fixture): A2UI surface support (`SISendMessageResponse.response.surface`),
streaming turns (real Agentforce / Assistants emit SSE), consent-version
gate (a brand with `requires_identity: true`), anonymous_session_id
assertion, multi-brand catalog overlap (one customer fronting many
brands with shared products), ACP handoff failure mode, eager
`pending_handoff` mid-turn path (mock currently surfaces close hints
lazily — adapter chooses whether to project as eager handoff).

Refs adcontextprotocol/adcp#3961.
