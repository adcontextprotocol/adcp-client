---
name: build-governance-agent
description: Use when building an AdCP governance agent — campaign governance (spending authority, approval/denial), property/collection lists for brand safety, or content standards for creative compliance.
---

# Build a Governance Agent

A governance agent enforces policy on the buy side. It evaluates spending authority, maintains property and collection lists, and defines content standards. There is no dedicated `hello_governance_adapter_*.ts` yet — this skill collapses against the seller adapter pattern and the documented tool surface.

## Pick your fork target

| Specialism | Status | Fork this | Storyboard |
| --- | --- | --- | --- |
| `governance-spend-authority` | stable | [`hello_seller_adapter_multi_tenant.ts`](../../examples/hello_seller_adapter_multi_tenant.ts) — `campaignGovernance` block | `governance_spend_authority` |
| `governance-delivery-monitor` | stable | Same; add `phase: 'delivery'` branch on `checkGovernance` | `governance_delivery_monitor` |
| `property-lists` | stable | [`hello_seller_adapter_multi_tenant.ts`](../../examples/hello_seller_adapter_multi_tenant.ts) — `propertyLists` block | `property_lists` |
| `collection-lists` | stable | Same shape as property-lists; add IMDb/Gracenote/EIDR resolution | placeholder |
| `content-standards` | stable | Add `contentStandards` domain group via `defineContentStandardsPlatform` | placeholder |
| `measurement-verification` | preview | v3.1 placeholder. Baseline only. | placeholder |

The multi-tenant adapter is the canonical fork target — it implements `campaignGovernance` (sync_plans, check_governance, report_plan_outcome, get_plan_audit_logs), `propertyLists` (CRUD + `validate_property_delivery`), and `brandRights` against a per-tenant in-memory store with full tenant isolation via `createTenantStore`.

### What to delete if you're single-specialism

**Forking the multi-tenant adapter for a single specialism? Delete these blocks first** — leaning on stable symbol names rather than line numbers (the adapter evolves; greppable identifiers don't):

A single-specialism `governance-spend-authority` adopter (an in-house policy engine, IAS, DoubleVerify) deletes:

- The `brandRights = defineBrandRightsPlatform({ ... })` block (the entire brand-rights surface)
- The `propertyLists = definePropertyListsPlatform({ ... })` block if you don't claim `property-lists`
- The `private async enforceGovernance(...)` helper and the `interface GovernanceBinding` — these belong to `brandRights` cross-specialism dispatch, not to standalone governance
- Per-tenant `brands` / `rights` Maps on `TenantState` (no brand-rights catalog to seed)

A single-specialism `property-lists` adopter mirrors this: keep the `propertyLists` block; delete `campaignGovernance`, `brandRights`, `enforceGovernance`, the brand/rights Maps, and the `governanceBindings` map.

**Keep**: the `accounts` / `createTenantStore` block (translates to single-tenant by passing one tenant entry — needed for tenant isolation), `agentRegistry`, the specialism block(s) you claim, `getTenant(ctx)` resolution. **Don't keep `enforceGovernance` if you also delete `brandRights`** — the helper has no caller and wires a non-existent governance binding.

For `content-standards` and `collection-lists`, no worked fork target ships yet — wire `defineContentStandardsPlatform` / `defineCollectionListsPlatform` from `@adcp/sdk/server` against the multi-tenant scaffolding.

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
# Run the fork-matrix gate (tsc strict)
npm run compliance:fork-matrix -- --test-name-pattern="hello-seller-adapter-multi-tenant"

# Run your forked agent against the matching storyboard
adcp storyboard run http://127.0.0.1:3003/mcp governance_spend_authority \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json

# Property-lists track
adcp storyboard run http://127.0.0.1:3003/mcp property_lists \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate is the three-gate contract from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md). The multi-tenant adapter currently runs the strict-tsc gate only (no governance / brand-rights mock-server today); storyboard-grader gates land alongside the next mock-server family.

For deeper validation: [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Common shape gotchas

`policies[]` is `{ policy_id, enforcement, policy, ... }` — a wrapped policy, not a bare string. `validate_content_delivery` keys on `records[].artifact`, not `creative_id`. Property identity is `{agent_url, id}` (a `PropertyId`), not a bare string. `check_governance` response uses `decision: 'approved' | 'conditions' | 'denied'` — not boolean. See [`../SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md).

## Migration notes

- 6.6 → 6.7: [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md). Note: `inventory-lists` was renamed to `property-lists` in AdCP 3.0 GA (5.x → 5.2 migration).
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md)
