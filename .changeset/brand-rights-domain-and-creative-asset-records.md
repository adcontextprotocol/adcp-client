---
"@adcp/client": minor
---

Brand rights as a first-class server domain, plus creative-asset record shape alignment

**Brand rights first-class domain.** `createAdcpServer({ brandRights: {...} })` now accepts a domain group for the three schema-backed tools: `get_brand_identity`, `get_rights`, and `acquire_rights`. No more manual `server.tool()` registration, no bespoke `taskToolResponse` wrapping — context echo, account resolution, and `brand` protocol declaration in `get_adcp_capabilities` all work out of the box.

`update_rights` and `creative_approval` are intentionally **not** part of the domain group. The AdCP spec has no published JSON schemas for either — `creative_approval` is modeled as a webhook (POST to `approval_webhook` returned from `acquire_rights`), and `update_rights` is only described in prose. Adding permissive passthrough schemas just to satisfy a storyboard would be building to the test. They will be added when upstream schemas land (tracked in https://github.com/adcontextprotocol/adcp).

**Request-builder honors `sample_request` for `build_creative` and `sync_creatives`.** Hand-authored sample payloads are preserved end-to-end, so storyboards can exercise slot-specific briefs, format-scoped uploads, and multi-format requests without the builder overwriting them. Matches the behavior already present for `update_media_buy`, `create_media_buy`, `sync_plans`, and `calibrate_content`.

**Creative asset record shape.** All storyboard `sample_request.creatives[].assets` payloads now match the generated `CreativeAssetSchema`, which declares `assets` as `z.record(asset_id, asset)`. Agents validating requests against the generated Zod schemas will no longer reject storyboard payloads that previously used the array-of-asset-objects form. Fixes `creative_lifecycle`, `creative_template`, `creative_generative`, `creative_sales_agent`, `social_platform`, `media_buy_seller`, `media_buy_proposal_mode`, `media_buy_guaranteed_approval`, `deterministic_testing`, and `brand_rights`.

**Protocol gaps surfaced** (tracked for upstream AdCP spec work):
- `update_rights` and `creative_approval` lack published JSON schemas — the latter is spec'd as a webhook, so the gap is request/response schemas for either transport
- `error_compliance` storyboard is media-buy-scoped (requires `get_products`) — needs capability-aware dispatch to cover creative, signals, brand-rights, and governance agents

**Skill updates.**
- `build-brand-rights-agent/SKILL.md` rewritten around the new domain group and against the actual `schemas/cache/latest/brand/*.json` shapes (`names` as locale-keyed objects, `logos` with `orientation`/`background`/`variant`, `pricing_options` with `model`/`price`/`uses`, `acquire_rights` status discriminated union). Creative-approval flow is documented as an outbound webhook POST; `update_rights` is documented as a regular HTTP endpoint until schemas land.
