---
name: build-seller-agent
description: Use when building an AdCP seller agent — a publisher, SSP, or retail media network that sells advertising inventory to buyer agents.
---

# Build a Seller Agent

A seller agent receives briefs from buyers, returns products, accepts media buys, manages creatives, and reports delivery. The fastest path to a passing agent is to **fork a worked adapter** and replace its `// SWAP:` markers with calls to your backend. Each `// SWAP:` comment marks one line you change to your platform's backend call — change only those lines, run the gate, ship. ([`examples/CONTRIBUTING.md`](../../examples/CONTRIBUTING.md) covers the SWAP-marker convention in detail.) Proxy-shaped sellers use the lighter `proxy-seller-snap/` bridge-pattern fork target plus a live-OAuth sandbox runner. This skill tells you which adapter to fork and what cross-cutting rules apply across all of them.

## Pick your fork target

Each `hello_*_adapter_*` entry is a worked, currently-running, three-gate-tested reference adapter. `proxy-seller-snap/` is a bridge-pattern fork target for the seed-read problem; pair it with your own live-OAuth sandbox gate before production.

| Specialism              | Fork this                                                                                         | Mock upstream                               | Storyboard             |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------- |
| `sales-guaranteed`      | [`hello_seller_adapter_guaranteed.ts`](../../examples/hello_seller_adapter_guaranteed.ts)         | `npx adcp mock-server sales-guaranteed`     | `sales_guaranteed`     |
| `sales-non-guaranteed`  | [`hello_seller_adapter_non_guaranteed.ts`](../../examples/hello_seller_adapter_non_guaranteed.ts) | `npx adcp mock-server sales-non-guaranteed` | `sales_non_guaranteed` |
| `sales-social`          | [`hello_seller_adapter_social.ts`](../../examples/hello_seller_adapter_social.ts)                 | `npx adcp mock-server sales-social`         | `sales_social`         |
| Proxy-shaped seller     | [`proxy-seller-snap/`](../../examples/proxy-seller-snap/)                                        | upstream sandbox / OAuth                    | bridge + live run      |
| Multi-tenant holdco hub | [`hello_seller_adapter_multi_tenant.ts`](../../examples/hello_seller_adapter_multi_tenant.ts)     | composed                                    | per specialism         |

The other sales-\* specialisms reuse one of the primary fork targets and apply specialism deltas:

- [`sales-broadcast-tv`](specialisms/sales-broadcast-tv.md) — forks `hello_seller_adapter_guaranteed.ts`; deltas around DMA, GRP, daypart, agency estimate number, measurement windows.
- [`sales-streaming-tv`](specialisms/sales-streaming-tv.md) — forks `hello_seller_adapter_guaranteed.ts`; deltas around CTV (audience-vs-program targeting, reach/freq forecast). Preview specialism — placeholder storyboard.
- [`sales-proposal-mode`](specialisms/sales-proposal-mode.md) — forks `hello_seller_adapter_proposal_mode.ts`; deltas around `ProposalManager` two-platform composition, `ctx.recipes` hydration, sole-stateful exemption.
- `sales-exchange` — forks `hello_seller_adapter_non_guaranteed.ts`; preview specialism (placeholder storyboard).

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

Every sales-\* seller hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md). The high-traffic ones for sellers (deep-linked to the rule):

- [`idempotency_key`](../cross-cutting.md#idempotency_key-is-required-on-every-mutating-call) on every mutating request — `create_media_buy`, `update_media_buy`, `sync_creatives`, `sync_audiences`, etc.
- [Resolve-then-authorize](../cross-cutting.md#resolve-then-authorize--uniform-errors-for-not-found--not-yours) — byte-equivalent errors for `media_buy_id` cross-tenant lookups
- [Authentication](../cross-cutting.md#authentication-is-mandatory) — `serve({ authenticate })` baseline
- [Account resolution](../cross-cutting.md#account-resolution-pick-a-security-preset) — `createTenantStore` for multi-advertiser sellers
- [Webhooks](../cross-cutting.md#webhooks-stable-operation_id-across-retries) — stable `operation_id` for IO-approval / delivery-completion notifications

## Specialism deltas

The fork target covers the baseline. Specialism subpages cover the deltas — what to add when you claim that specialism on top of the baseline. Each entry below is **specialism → when to read it → what's in it**.

- [`specialisms/sales-guaranteed.md`](specialisms/sales-guaranteed.md) — **read before coding if you claim `sales-guaranteed`**: IO-task envelope, three `create_media_buy` return shapes (task envelope / `pending_creatives` / `active`), `TERMS_REJECTED` on aggressive `measurement_terms`. Applying only the task-envelope path fails 5 storyboard `create_media_buy` steps.
- [`specialisms/sales-non-guaranteed.md`](specialisms/sales-non-guaranteed.md) — **read if your inventory clears at request time** (programmatic auction, no HITL approval): sync confirmation, `bid_price`, `update_media_buy` for in-flight changes.
- [`specialisms/sales-broadcast-tv.md`](specialisms/sales-broadcast-tv.md) — **read if you sell linear / broadcast TV**: `agency_estimate_number`, Ad-ID `industry_identifiers`, `measurement_windows` (Live/C3/C7).
- [`specialisms/sales-streaming-tv.md`](specialisms/sales-streaming-tv.md) — **read if you sell CTV / OTT streaming inventory** (preview): audience-vs-program targeting, reach/freq forecast, frequency caps.
- [`specialisms/sales-social.md`](specialisms/sales-social.md) — **read if you're a social platform** (Snap, Meta, TikTok, etc.): additive — claim alongside `sales-non-guaranteed`. Adds `sync_audiences`, `sync_catalogs` (DPA), `log_event` (conversions), `get_account_financials`.
- [`specialisms/sales-proposal-mode.md`](specialisms/sales-proposal-mode.md) — **read if you negotiate via proposals before line-itemizing**: `proposals[]` with `budget_allocations`, `buying_mode: 'refine'`.
- [`specialisms/audience-sync.md`](specialisms/audience-sync.md) — **read if buyers push audiences to you** (walled-garden + identity-provider patterns): `sync_audiences` track. Hashed identifiers, match-rate telemetry.
- [`specialisms/signed-requests.md`](specialisms/signed-requests.md) — **read if you accept buyer-signed requests on mutating tools**: RFC 9421 verification, `WWW-Authenticate: Signature error="<code>"` on rejection.

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

## Test surfaces — making your agent verifiable without live credentials

Every seller faces the same compliance question: can the runner verify your wire format separately from your live behavior? Wire format gets tested against fixtures. Live behavior needs a real test surface — sandbox credentials, real catalog data, real adapter traffic. The two are independent and produce different reliability claims (see [`adcp-client#1782`](https://github.com/adcontextprotocol/adcp-client/issues/1782) and [`adcontextprotocol/adcp#4593`](https://github.com/adcontextprotocol/adcp/issues/4593) for the certification model under discussion).

To pass storyboards, you need the runner's `comply_test_controller.seed_product` writes to flow into your handler's `get_products` reads — the seed→read loop has to close. How you close it depends on where your handlers fetch from, not on what kind of seller you are:

- **Handler reads from a store you control** (most SSPs, most creative agents — `audience-sync` adopters with a local audience cache, `creative-template` adopters with a local format registry). Point `comply_test_controller` at the same store. Seed writes to your DB, handler reads from your DB, loop closes naturally. **No bridge needed** — if seeds DO appear in responses but your `tsc` / type-check fails on seed-merge wiring, you wired it unnecessarily; remove it.

- **Handler reads from a system you don't control** (DSPs proxying to Meta/Snap/TikTok, retail-media networks reading retailer catalog APIs, signals agents brokering third-party data marketplaces, walled-garden brokers). A seeded write to your local store is dead — your handler never sees it; if `comply_test_controller` seeds never appear in your responses, that's the symptom. **Wire the `TestControllerBridge`** ([`docs/guides/VALIDATE-YOUR-AGENT.md` § "Platform-proxy sellers"](../../docs/guides/VALIDATE-YOUR-AGENT.md#platform-proxy-sellers-state-of-record-lives-upstream)). The real handler still runs first (so a broken upstream call still fails the conformance gate), and the SDK merges seeded fixtures into the response after.

  Start from [`examples/proxy-seller-snap/`](../../examples/proxy-seller-snap/) for the concrete fork shape: `TestControllerBridge<TAccount>`, `bridgeFromSessionStore`, resolved-account session keying, `getSeededProducts`, `getSeededCreatives`, and governance list selectors. Keep `resolveAccount` as the production trust boundary and pair bridge-green storyboards with a live-OAuth sandbox run; bridge passes prove wire conformance, not upstream adapter health.

Either path earns the **wire-conformance** half of compliance — your storyboards pass, you speak AdCP correctly. The **live-integration** half requires marker-free passes against a real test surface (sandbox credentials with real upstream traffic), independent of whether the bridge is wired. The `_bridge` marker the SDK stamps on bridge-merged responses tracks which steps in a storyboard run used fixtures vs real upstream.

> Certification names in #1782 are under review; the mechanism here is stable.

## Deployment

Single-host HTTP from `serve(...)` is the default. Multi-host, Express, or stdio transports: [`deployment.md`](deployment.md).

## Common shape gotchas

`BuildCreativeReturn` has 4 valid shapes (framework auto-wraps the bare manifest). `VASTAsset` requires an embedded `delivery_type` discriminator. Targeting overlay echo on `get_media_buys` requires `createMediaBuyStore`. See [`SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md) — schema validators catch these at runtime; type checkers don't.

## Migration notes

- 6.6 → 6.7: **Two seller-affecting breaking changes — audit before bumping**: `accounts.resolution: 'implicit'` now refuses inline `{account_id}` references (#10), and `SalesPlatform` split into `SalesCorePlatform & SalesIngestionPlatform` (#11) — all methods individually optional, self-announcing under `tsc --noEmit`. See [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md) for the worked diff plus 15 additive recipes around `definePlatform`, `composeMethod`, typed errors, `BuyerAgentRegistry`.
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md). Full v5 path including `createAdcpServer`, `serve({ authenticate })`, and the 5.13 pin to AdCP 3.0.0 GA.
