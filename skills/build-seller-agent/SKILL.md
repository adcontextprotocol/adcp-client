---
name: build-seller-agent
description: Use when building an AdCP seller agent — a publisher, SSP, or retail media network that sells advertising inventory to buyer agents.
---

# Build a Seller Agent

A seller agent receives briefs from buyers, returns products, accepts media buys, manages creatives, and reports delivery. The fastest path to a passing agent is to **fork a worked adapter** and replace its `// SWAP:` markers with calls to your backend. Each `// SWAP:` comment marks one line you change to your platform's backend call — change only those lines, run the gate, ship. ([`examples/CONTRIBUTING.md`](../../examples/CONTRIBUTING.md) covers the SWAP-marker convention in detail.) This skill tells you which adapter to fork and what cross-cutting rules apply across all of them.

## Pick your fork target

Each of these is a worked, currently-running, three-gate-tested reference adapter. Fork it, swap the upstream, ship.

| Specialism | Fork this | Mock upstream | Storyboard |
| --- | --- | --- | --- |
| `sales-guaranteed` | [`hello_seller_adapter_guaranteed.ts`](../../examples/hello_seller_adapter_guaranteed.ts) | `npx adcp mock-server sales-guaranteed` | `sales_guaranteed` |
| `sales-non-guaranteed` | [`hello_seller_adapter_non_guaranteed.ts`](../../examples/hello_seller_adapter_non_guaranteed.ts) | `npx adcp mock-server sales-non-guaranteed` | `sales_non_guaranteed` |
| `sales-social` | [`hello_seller_adapter_social.ts`](../../examples/hello_seller_adapter_social.ts) | `npx adcp mock-server sales-social` | `sales_social` |
| Multi-tenant holdco hub | [`hello_seller_adapter_multi_tenant.ts`](../../examples/hello_seller_adapter_multi_tenant.ts) | composed | per specialism |

The other sales-* specialisms (`sales-broadcast-tv`, `sales-streaming-tv`, `sales-exchange`, `sales-proposal-mode`) currently fork from `sales-guaranteed` or `sales-non-guaranteed` and apply specialism deltas — see `specialisms/<id>.md`. `sales-streaming-tv` and `sales-exchange` are preview specialisms with placeholder storyboards (claim them to advertise intent; baseline is all that's enforced today).

For exact response shapes, error codes, and optional fields, `docs/llms.txt` is the canonical reference. The fork target stays in sync with the spec because PR #1394's three-gate contract fails CI when it drifts.

## When to use this skill

- User wants to sell ad inventory (publisher, SSP, retail media network)
- User mentions `get_products`, `create_media_buy`, or the media buy protocol

**Not this skill:**

- Building an agency / holdco hub hosting multiple specialisms → `skills/build-holdco-agent/`
- Catalog-driven inventory (retail media, restaurants, travel) → `skills/build-retail-media-agent/`
- AI ad network coupling generation with sales → `skills/build-generative-seller-agent/`
- Buying inventory → `docs/getting-started.md` covers the buyer side

**Often claimed alongside:** [`audience-sync`](specialisms/audience-sync.md) (walled-garden social + identity provider patterns), `signal-marketplace` (DSP-side data surface), `sales-catalog-driven` (retail-media catalog + dynamic-creative). See [Common multi-specialism bundles](../../examples/README.md#common-multi-specialism-bundles).

## Cross-cutting rules

Every sales-* seller hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md) — `idempotency_key` on every mutating request, resolve-then-authorize uniform errors, mandatory authentication, signed-requests transparency, `ctx_metadata` is not for credentials, account-resolution security presets, webhook `operation_id` stability. Read it once.

## Specialism deltas

The fork target covers the baseline. Specialism subpages cover the deltas — what to add when you claim that specialism on top of the baseline.

- [`specialisms/sales-guaranteed.md`](specialisms/sales-guaranteed.md) — IO-task envelope, three `create_media_buy` return shapes (task envelope / `pending_creatives` / `active`), `TERMS_REJECTED` on aggressive `measurement_terms`. **Read before coding** — applying only the task-envelope path fails 5 storyboard `create_media_buy` steps.
- [`specialisms/sales-non-guaranteed.md`](specialisms/sales-non-guaranteed.md) — sync confirmation, `bid_price`, `update_media_buy` for in-flight changes
- [`specialisms/sales-broadcast-tv.md`](specialisms/sales-broadcast-tv.md) — `agency_estimate_number`, Ad-ID `industry_identifiers`, `measurement_windows` (Live/C3/C7)
- [`specialisms/sales-social.md`](specialisms/sales-social.md) — additive: claim alongside `sales-non-guaranteed`. Adds `sync_audiences`, `sync_catalogs` (DPA), `log_event` (conversions), `get_account_financials`
- [`specialisms/sales-proposal-mode.md`](specialisms/sales-proposal-mode.md) — `proposals[]` with `budget_allocations`, `buying_mode: 'refine'`
- [`specialisms/audience-sync.md`](specialisms/audience-sync.md) — `sync_audiences` track. Hashed identifiers, match-rate telemetry
- [`specialisms/signed-requests.md`](specialisms/signed-requests.md) — RFC 9421 verification on mutating requests; `WWW-Authenticate: Signature error="<code>"` on rejection

`sales-catalog-driven` and `sales-retail-media` live in `skills/build-retail-media-agent/` because catalog-driven applies beyond retail (restaurants, travel, local commerce).

## Validate locally

```bash
# Run the fork-matrix gate for your adapter (~9s, deterministic)
npm run compliance:fork-matrix -- --test-name-pattern="hello-seller-adapter-guaranteed"

# Or validate your forked agent directly against its storyboard
adcp storyboard run http://127.0.0.1:3004/mcp sales_guaranteed \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate is the three-gate contract from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md): tsc strict / storyboard zero-failures / upstream façade. Adopters who fork a hello adapter inherit the gate by extending the test file with their own adapter path and `expectedRoutes`.

If the gate fails on a storyboard step (not on tsc), re-run the `adcp storyboard run ... --json` command above for the human-readable `💡 Hint:` lines — node:test's assertion formatting compresses them.

For deeper validation (fuzz, request-signing grading, multi-instance, custom invariants): [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Deployment

Single-host HTTP from `serve(...)` is the default. Multi-host, Express, or stdio transports: [`deployment.md`](deployment.md).

## Common shape gotchas

`BuildCreativeReturn` has 4 valid shapes (framework auto-wraps the bare manifest). `VASTAsset` requires an embedded `delivery_type` discriminator. Targeting overlay echo on `get_media_buys` requires `createMediaBuyStore`. See [`SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md) — schema validators catch these at runtime; type checkers don't.

## Migration notes

- 6.6 → 6.7: **Two seller-affecting breaking changes — audit before bumping**: `accounts.resolution: 'implicit'` now refuses inline `{account_id}` references (#10), and `SalesPlatform` split into `SalesCorePlatform & SalesIngestionPlatform` (#11) — all methods individually optional, self-announcing under `tsc --noEmit`. See [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md) for the worked diff plus 15 additive recipes around `definePlatform`, `composeMethod`, typed errors, `BuyerAgentRegistry`.
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md). Full v5 path including `createAdcpServer`, `serve({ authenticate })`, and the 5.13 pin to AdCP 3.0.0 GA.
