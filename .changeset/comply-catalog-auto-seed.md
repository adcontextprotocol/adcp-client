---
"@adcp/sdk": patch
---

feat(server): catalog-backed auto-seed for comply_test_controller

When `createAdcpServerFromPlatform` is called with `complyTest` and a sales
platform that wires `getProducts`, but without explicit `seed.product` or
`seed.pricing_option` adapters, the framework now auto-derives those adapters
from an in-memory store and wires a `testController` bridge so seeded products
appear in `get_products` responses on sandbox requests.

This removes the footgun where LLM-generated platforms fail comply storyboards
because the slim skill guide doesn't mention that `seed_product` requires an
explicit adapter. Publishers wiring `getProducts` now get free comply-sandbox
seeding without writing any seed adapter code.

The store is keyed by `account.account_id` so two sandbox accounts on the
same server (multi-tenant TenantRegistry hosts, or single-tenant servers with
multiple sandbox accounts) never share a seed namespace. Adopters who need
tighter scoping (per-session, per-brand) wire `bridgeFromSessionStore`
explicitly.

Explicit `seed.product` / `seed.pricing_option` adapters and explicit
`testController` bridges always take priority — the auto-seed is only applied
when neither is present.
