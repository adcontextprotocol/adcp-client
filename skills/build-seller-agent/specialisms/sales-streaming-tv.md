# Specialism: sales-streaming-tv

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-streaming-tv`.

**Status: preview.** The storyboard is a placeholder (`phases: []` in `index.yaml`); claim the specialism to advertise CTV intent. Today only the protocol baseline is enforced — the deltas below are forward-looking guidance so adopters write CTV-shaped responses now and gate-pass when phases land.

**Fork target**: [`examples/hello_seller_adapter_guaranteed.ts`](../../../examples/hello_seller_adapter_guaranteed.ts) — CTV reservation inventory is guaranteed (impressions + audience). Inherit the IO-task envelope, three `create_media_buy` return shapes, and `targeting_overlay` echo pattern from [`sales-guaranteed.md`](sales-guaranteed.md). Apply the streaming deltas below. See [SHAPE-GOTCHAS.md](../../SHAPE-GOTCHAS.md) for response-shape pitfalls.

## What's different from `sales-guaranteed`

CTV sits between digital and broadcast. The buyer wants impressions and audience guarantees (digital), but the planning surface uses GRP-style reach/freq (broadcast). The differences from `sales-guaranteed` are mostly about which targeting / pricing axes you surface, not new protocol shapes.

## Audience-vs-program targeting

CTV inventory is sold two ways; the seller chooses per product:

- **Audience-bought** — buyer specifies demos / segments via `targeting_overlay.audiences` and `targeting_overlay.signals`. Seller resolves to whichever programs match. Most CTV inventory ships this way.
- **Program-bought** — buyer specifies titles / shows / genres via `targeting_overlay.contextual` (or a publisher-property list). Seller fulfills against that exact program slate.

Declare which axis a product supports via its `format_ids` and `publisher_properties`. Don't accept program targeting on an audience-bought product — surface `INVALID_REQUEST` with a hint pointing at the supported overlay path. The `targeting_overlay` echo rule from [`sales-guaranteed.md`](sales-guaranteed.md) applies — persist verbatim, echo verbatim.

## Forecast surface — `'reach_freq'` or `'availability'`

CTV planning uses both:

- **`reach_freq`** — unique reach + frequency on a target demo at planned weight. Each `Product.forecast.points[i].metrics` includes `reach_unique`, `frequency_avg`, `grps` (or `irps` for incremental reach), `spend`.
- **`availability`** — for fully-spec'd reservations (single point, `metrics.impressions` + `metrics.audience_size`, `metrics.spend` is the quoted cost, no `budget`).

Choose per product / per query. Drive from your real demo-projection upstream (Nielsen, VideoAmp, iSpot) — static `availability` blobs read as placeholder during the storyboard.

## Day-of-week + daypart on streaming

Live streaming inventory honors the broadcast `dayparts` enum (`early_morning`, `daytime`, `prime_access`, `prime`, `late_news`, `overnight`). VOD / library inventory typically ignores daypart — surface `INVALID_REQUEST` with a hint if the buyer sends `targeting_overlay.dayparts` against a VOD-only product.

## Measurement windows — same shape as broadcast

CTV billing typically settles on a digital window (`served`) or a panel-blended window (`c3` / `c7` for cross-screen reach). Use the broadcast `measurement_windows` shape from [`sales-broadcast-tv.md`](sales-broadcast-tv.md#measurement-windows--array-of-objects-not-enum-strings) — array of `MeasurementWindow` objects, not enum strings.

## Frequency caps

CTV buyers cap on user-day or user-campaign basis. Surface via `Product.frequency_capping_options` and accept on `packages[].frequency_caps`. Sellers that can't enforce a requested cap should reject with `INVALID_REQUEST` rather than silently dropping the cap.

## Cross-screen attribution

Cross-screen attribution (CTV → mobile / web) lands in AdCP 3.1 alongside the closed-loop attribution surface — out of scope for the 3.0 baseline. Sellers can attach `measurement_partners` to a product and let the buyer subscribe to the feed out-of-band.
