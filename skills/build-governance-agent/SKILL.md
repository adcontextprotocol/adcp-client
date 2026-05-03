---
name: build-governance-agent
description: Use when building an AdCP governance agent — campaign governance (spending authority, approval/denial), property/collection lists for brand safety, or content standards for creative compliance.
---

# Build a Governance Agent

A governance agent enforces policy on the buy side. It evaluates spending authority, maintains property and collection lists, and defines content standards. There is no dedicated `hello_governance_adapter_*.ts` yet — this skill collapses against the seller adapter pattern and the documented tool surface.

## Pick your fork target

| Specialism | Status | Fork pattern | Storyboard |
| --- | --- | --- | --- |
| `governance-spend-authority` | stable | Seller adapter pattern + `campaignGovernance` domain group | `governance_spend_authority` |
| `governance-delivery-monitor` | stable | Same + `phase: 'delivery'` branch | `governance_delivery_monitor` |
| `property-lists` | stable | `propertyLists` domain group + CRUD + `validate_property_delivery` | `property_lists` |
| `collection-lists` | stable | `collectionLists` domain group + IMDb/Gracenote/EIDR resolution | placeholder |
| `content-standards` | stable | `contentStandards` domain group + `validate_content_delivery` | placeholder |
| `measurement-verification` | preview | v3.1 placeholder. Baseline only. | placeholder |

A worked governance fork target is tracked as a follow-up. Until then, use [`hello_seller_adapter_guaranteed.ts`](../../examples/hello_seller_adapter_guaranteed.ts) as the wiring reference (`createAdcpServerFromPlatform`, `serve`, idempotency store, `comply_test_controller` block) and add the governance domain groups via `defineCampaignGovernancePlatform` / `definePropertyListsPlatform` / `defineContentStandardsPlatform` from `@adcp/sdk/server`.

For exact response shapes, error codes, and optional fields, `docs/llms.txt` is the canonical reference.

## When to use this skill

- User wants to enforce campaign governance, property lists, collection lists, or content standards
- User describes themselves as a brand-safety vendor (IAS, DoubleVerify), policy engine (OPA/Cerbos), or compliance platform
- User mentions `check_governance`, `validate_property_delivery`, `validate_content_delivery`

**Not this skill:**

- Selling inventory while consuming governance signals → `skills/build-seller-agent/` (governance-aware seller track)
- Brand identity / rights licensing → `skills/build-brand-rights-agent/`
- Audience sync (despite the name overlap) → `skills/build-seller-agent/` (audience-sync track)

## Cross-cutting rules

Every governance agent hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md). One governance-specific rule on top:

### `comply_test_controller` is required

Both `governance_spend_authority` and `property_lists` storyboards seed fixtures via `comply_test_controller.seed_plan` / `seed_property_list` before running the business-logic phases. Register via `createComplyController({ seed: { plan, property_list, collection_list, content_standards } })` and call `controller.register(server)` — same pattern as the seller adapter wires for media-buy seeding.

Without the test controller, every business-logic step skips with `missing_test_controller` and the track "passes" vacuously — the grader treats vacuous green as fail. Wire it on day one.

## Specialism deltas at a glance

**`governance-spend-authority`** — `check_governance` evaluates the request's `binding` against the Plan's `budget.total`, `human_review_required`, and `custom_policies`. Returns one of `approved` / `conditions` / `denied`. The Plan model is the source of truth: read `sync_plans` / `get_plan` to materialize the spending authority, then check the inbound binding against it.

**`governance-delivery-monitor`** — `check_governance` with `phase: 'delivery'` + `delivery_metrics`. Compute drift vs Plan's `budget.reallocation_threshold`; return `BUDGET_DRIFT_EXCEEDED` findings when delivery exceeds the threshold.

**`property-lists`** — tool family `property_list_*` (`create`, `read`, `update`, `delete`, `list`). `validate_property_delivery` returns full `violations[]` (publisher property not in the inclusion list, or hit the exclusion list). Property identity is `{agent_url, id}` — buyers fetch lists by reference, not by inline copy.

**`collection-lists`** — program-level brand safety (shows, series, podcasts) identified by platform-independent IDs: **IMDb** (movies/TV), **Gracenote** (TV/audio metadata), **EIDR** (entertainment industry standard). Mirrors property-lists CRUD plus collection resolution.

**`content-standards`** — `policies[]` is an array of `{ policy_id, enforcement, policy, policy_categories?, channels? }`. `validate_content_delivery` uses `records[].artifact` (not `creative_id`). Re-read policies per call so `standards_version_change` events don't serve stale policy.

**`measurement-verification`** — v3.1 placeholder (empty `phases`). Pass universal + governance baseline only. Advertise the capability for discoverability.

## Validate locally

```bash
# Run your forked agent against the matching storyboard
adcp storyboard run http://127.0.0.1:3008/mcp governance_spend_authority \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json

# Property-lists track
adcp storyboard run http://127.0.0.1:3008/mcp property_lists \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate pattern from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md) (tsc strict / storyboard zero-failures / upstream façade) applies — when the worked governance adapter lands, it'll plug into the same gate.

For deeper validation: [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Common shape gotchas

`policies[]` is `{ policy_id, enforcement, policy, ... }` — a wrapped policy, not a bare string. `validate_content_delivery` keys on `records[].artifact`, not `creative_id`. Property identity is `{agent_url, id}` (a `PropertyId`), not a bare string. `check_governance` response uses `decision: 'approved' | 'conditions' | 'denied'` — not boolean. See [`../SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md).

## Migration notes

- 6.6 → 6.7: [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md). Note: `inventory-lists` was renamed to `property-lists` in AdCP 3.0 GA (5.x → 5.2 migration).
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md)
