---
name: build-retail-media-agent
description: Use when building an AdCP retail media network agent — a platform that sells on-site placements, supports product catalogs, tracks conversions, and reports performance. Applies to retail, restaurants, travel, and any platform rendering ads from a feed.
---

# Build a Retail Media Agent

A retail media agent is a seller agent that adds catalog ingestion, conversion tracking, and performance feedback. The fastest path is to **fork a seller adapter** and add the catalog-driven surface on top.

## Pick your fork target

There's no dedicated `hello_retail_media_adapter_*.ts` yet — retail-media is additive on top of `sales-non-guaranteed`, so adopters fork the seller adapter and add the catalog surface.

| Specialism | Status | Fork this | Add | Storyboard |
| --- | --- | --- | --- | --- |
| `sales-catalog-driven` | stable | [`hello_seller_adapter_non_guaranteed.ts`](../../examples/hello_seller_adapter_non_guaranteed.ts) | `syncCatalogs`, `syncEventSources`, `logEvent`, `providePerformanceFeedback` | `sales_catalog_driven` |
| `sales-retail-media` | preview | Same | + retail-specific surface encoding in `publisher_properties` / `format_ids` (search vs PDP vs homepage vs offsite vs in-store) | placeholder |

A worked retail-media fork target is tracked as a follow-up. Until then, the seller `hello_seller_adapter_non_guaranteed.ts` is the closest baseline; the deltas are in [`docs/llms.txt`](../../docs/llms.txt) under `#### \`sync_catalogs\``, `#### \`sync_event_sources\``, `#### \`log_event\``, `#### \`provide_performance_feedback\``.

For exact response shapes, error codes, and optional fields, `docs/llms.txt` is the canonical reference.

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

Every retail-media agent hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md). Plus all the seller cross-cutting from [`../build-seller-agent/SKILL.md`](../build-seller-agent/SKILL.md) — retail-media is additive on top of the seller baseline.

## Specialism deltas at a glance

**`sales-catalog-driven`** —

- Products declare `supports_catalog: true` and `supports_conversion_tracking: true`
- `create_media_buy` accepts `packages[].catalogs[]` referencing previously-synced catalog ids
- `sync_catalogs` ingests product feeds (JSON/CSV/XML) with at minimum `product_id`, `title`, `price`, `image_url`, `category`
- `sync_event_sources` registers conversion endpoints (purchase, add_to_cart, page_view, search)
- `log_event` accepts conversion events with `content_ids` and returns a `match_quality` score; counter-only responses pass the storyboard (closed-loop attribution lands in 3.1)
- `provide_performance_feedback` accepts buyer optimization signals back

**`sales-retail-media`** — currently a v3.1 placeholder (empty `phases`). Ship the catalog-driven baseline plus retail-specific surface encoding in `publisher_properties` / `format_ids`. Claim the specialism to advertise intent.

Attribution linkage (`log_event.content_ids` → catalog `item_id` → `media_buy_id`) is deliberately out-of-scope for AdCP 3.0 — the storyboard accepts counter-only responses. Closed-loop attribution + ROAS reporting land in 3.1.

## Validate locally

```bash
# Run the fork-matrix gate against the seller-non-guaranteed baseline
npm run compliance:fork-matrix -- --test-name-pattern="hello-seller-adapter-non-guaranteed"

# Or validate your forked agent directly against the catalog-driven storyboard
adcp storyboard run http://127.0.0.1:3005/mcp sales_catalog_driven \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate is the three-gate contract from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md): tsc strict / storyboard zero-failures / upstream façade.

For deeper validation: [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Common shape gotchas

`get_media_buy_delivery /reporting_period/start|end` are ISO 8601 **date-time** strings, not date-only. Per-package billing rows require `package_id`, `spend`, `pricing_model`, `rate`, `currency`. `sync_accounts` rows require `action: 'created' | 'updated' | 'unchanged' | 'failed'`. See [`../SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md).

## Migration notes

- 6.6 → 6.7: [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md)
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md)
