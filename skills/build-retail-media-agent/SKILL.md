---
name: build-retail-media-agent
description: Use when building an AdCP retail media network agent — a platform that sells on-site placements, supports product catalogs, tracks conversions, and reports performance. Applies to retail, restaurants, travel, and any platform rendering ads from a feed.
---

# Build a Retail Media Agent

A retail media agent sells on-site placements driven by a product catalog and reports conversion outcomes back to buyers. The fastest path is to **fork a worked seller adapter** and replace its `// SWAP:` markers with calls to your backend.

## Pick your fork target

| Specialism             | Status  | Fork this                                                                         | Mock upstream                       | Storyboard             |
| ---------------------- | ------- | --------------------------------------------------------------------------------- | ----------------------------------- | ---------------------- |
| `sales-catalog-driven` | stable  | [`hello_seller_adapter_social.ts`](../../examples/hello_seller_adapter_social.ts) | `npx adcp mock-server sales-social` | `sales_catalog_driven` |
| `sales-retail-media`   | preview | Same                                                                              | Same                                | placeholder            |

The social fork target is the closest baseline because it already implements the catalog-driven surface (`syncCatalogs`, `syncEventSources`, `logEvent`) on top of `SalesIngestionPlatform`. Walled-garden social platforms and retail media networks share the same wire-level shape — buyer pushes catalogs and audiences, platform reports conversions, both close the loop via `provide_performance_feedback`. Apply the retail-specific deltas below.

For exact response shapes, error codes, and optional fields, [`docs/llms.txt`](../../docs/llms.txt) is the canonical reference. The fork target stays in sync with the spec because PR #1394's three-gate contract fails CI when it drifts.

## When to use this skill

- User is building a retail media network (Criteo RMN, Amazon DSP, Kroger Precision)
- User mentions catalog-driven creative, dynamic product ads, on-site sponsored listings
- User describes restaurants / travel / local commerce platforms rendering ads from a product feed
- User mentions `sync_catalogs`, `log_event`, or `provide_performance_feedback`

**Not this skill:**

- Generic display / video selling without a catalog → `skills/build-seller-agent/`
- AI-generated ads coupled with selling → `skills/build-generative-seller-agent/`

`sales-catalog-driven` applies far beyond retail — restaurants (DoorDash sponsored listings), travel (Expedia accelerator), local commerce (Yelp). The storyboard tests the catalog + event surface, not the vertical.

## Cross-cutting rules

Every retail-media agent hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md) plus the seller cross-cutting from [`../build-seller-agent/SKILL.md`](../build-seller-agent/SKILL.md) — retail-media is additive on top of the seller baseline. The high-traffic ones for retail-media:

- [`idempotency_key`](../cross-cutting.md#idempotency_key-is-required-on-every-mutating-call) on `sync_catalogs`, `sync_event_sources`, `log_event`, `provide_performance_feedback`
- [Webhooks](../cross-cutting.md#webhooks-stable-operation_id-across-retries) — for catalog-ingestion completions, use `catalog_sync.${catalog_id}.${batch_id}` as the stable `operation_id`
- [SHAPE-GOTCHAS §6](../SHAPE-GOTCHAS.md#6-log_event-projection-for-walled-garden-capis) — `log_event` field-name + UNIX-seconds + `user_match` projections (shared with sales-social CAPIs)

## Specialism deltas

### `sales-catalog-driven`

What's different from the social baseline you forked:

- **Products declare catalog support**: `supports_catalog: true` and `supports_conversion_tracking: true` on each `Product`.
- **`create_media_buy` accepts `packages[].catalogs[]`** — references to previously-synced catalog ids. The seller renders the dynamic ad from the catalog row at serve time.
- **`sync_catalogs`** ingests product feeds (JSON / CSV / XML). Required per-row fields: `product_id`, `title`, `price`, `image_url`, `category`. Reject rows missing any of these with a structured error and surface the per-row failures in the response.
- **`sync_event_sources`** registers conversion endpoints — `purchase`, `add_to_cart`, `page_view`, `search`. Each event source has a `source_id` the buyer references on subsequent `log_event` calls.
- **`log_event` accepts `content_ids`** — the catalog row IDs the conversion attaches to. Counter-only responses pass the storyboard today; closed-loop attribution lands in 3.1.
- **`provide_performance_feedback`** accepts buyer optimization signals (clicked / not-clicked / converted / not-converted on specific impressions). Use it to close the bid-quality loop.

### `sales-retail-media`

Currently a v3.1 placeholder (empty `phases` in `index.yaml`); the protocol baseline is all that's enforced today. Claim the specialism to advertise intent. The forward-looking deltas on top of `sales-catalog-driven`:

- **Onsite placement encoding** in `publisher_properties` and `format_ids` — search results, product detail page (PDP), homepage, category, offsite (display retargeting), in-store (DOOH).
- **Sponsored-product vs sponsored-display** distinction surfaces as separate `format_ids` per product.
- **Offsite + in-store** require `publisher_properties.environment` to disambiguate the rendering surface (web vs DOOH vs CTV) — the buyer's targeting overlays vary by environment.
- **Closed-loop ROAS** lands with attribution in 3.1.

## Validate locally

```bash
# Run the fork-matrix gate against the social baseline
npm run compliance:fork-matrix -- --test-name-pattern="hello-seller-adapter-social"

# Or validate your forked agent directly against the catalog-driven storyboard
adcp storyboard run http://127.0.0.1:3005/mcp sales_catalog_driven \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate is the three-gate contract from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md): tsc strict / storyboard zero-failures / upstream façade.

For deeper validation: [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Common shape gotchas

`get_media_buy_delivery /reporting_period/start|end` are ISO 8601 **date-time** strings, not date-only. Per-package billing rows require `package_id`, `spend`, `pricing_model`, `rate`, `currency`. `sync_accounts` rows require `action: 'created' | 'updated' | 'unchanged' | 'failed'`. See [`../SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md) and [§6](../SHAPE-GOTCHAS.md#6-log_event-projection-for-walled-garden-capis) for `log_event` field-rename + UNIX-seconds patterns shared with social CAPIs.

## Migration notes

- 6.6 → 6.7: [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md)
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md)
