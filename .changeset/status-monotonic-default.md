---
'@adcp/client': minor
---

Register the fourth default cross-step assertion `status.monotonic` (adcontextprotocol/adcp#2664). Resource statuses observed across storyboard steps MUST transition only along edges in the spec-published lifecycle graph for their resource type. Catches regressions like `active → pending_creatives` on a media_buy, or `approved → processing` on a creative asset, that per-step validations cannot detect.

**Tracked lifecycles** (one transition table per resource type, hardcoded against the enum schemas in `static/schemas/source/enums/*-status.json` in the spec repo, with bidirectional edges listed explicitly):

- `media_buy` — forward flow `pending_creatives → pending_start → active`, `active ↔ paused` reversible, terminals `completed | rejected | canceled`.
- `creative` (asset lifecycle) — forward flow `processing → pending_review → approved | rejected`, `approved ↔ archived` reversible, `rejected → processing | pending_review` allowed on re-sync, no terminals.
- `creative_approval` — per-assignment on a package, forward `pending_review → approved | rejected`, `rejected → pending_review` allowed on re-sync.
- `account` — `active ↔ suspended` and `active ↔ payment_required` reversible, terminals `rejected | closed`.
- `si_session` — forward `active → pending_handoff → complete | terminated`, terminals `complete | terminated`.
- `catalog_item` — forward `pending → approved | rejected | warning`, `approved ↔ warning` reversible, `rejected → pending` allowed on re-sync.
- `proposal` — one-way `draft → committed`.

**Observations** are drawn from task-aware extractors on `stepResult.response`: `create_media_buy` / `update_media_buy` / `get_media_buys`, `sync_creatives` / `list_creatives`, nested `.packages[].creative_approvals[]`, `sync_accounts` / `list_accounts`, `si_initiate_session` / `si_send_message` / `si_terminate_session`, `sync_catalogs` / `list_catalogs` (per-item), `get_products` (when the response carries a `proposal`). Unknown tasks produce no observations.

**State** is scoped `(resource_type, resource_id)` so independent resources don't interfere. Self-edges (same status re-read) are silent pass. Skipped / errored / `expect_error: true` steps don't record observations. Unknown enum values (drift) reset the anchor without failing — `response_schema` catches enum violations.

Failure output names the resource, the illegal transition, and the two step ids: `media_buy mb-1: active → pending_creatives (step "create" → step "regress") is not in the lifecycle graph.` Consumers who need a stricter variant can `registerAssertion(spec, { override: true })`.

18 new unit tests cover forward flows, terminal enforcement, bidirectional edges, skip semantics, (resource_type, resource_id) scoping, nested creative_approval arrays, adcp_error-gated observations, enum-drift tolerance.
