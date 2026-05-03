# Forecast & planning surface

`AdCP 3.0` ships a complete forecast/planning surface via `Product.forecast: DeliveryForecast`. This guide covers what the surface includes, when to populate it, and how to project upstream forecast/availability/reach-estimation responses onto AdCP wire shape.

The surface has been ahead of most adapters — the planning patterns documented here have wire support that adopters often don't know exists. If you're building a seller agent and your buyers are asking "what reach can I get for $X" or "what budget do I need to hit Y conversions," the answer is `Product.forecast` with the right `forecast_range_unit`.

## What the surface covers

Every `Product.forecast` is a `DeliveryForecast` with at least one `ForecastPoint`. The `forecast_range_unit` field tells the buyer how to interpret the points:

| `forecast_range_unit` | Curve interpretation                                                                | Canonical use case                                                  |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `'spend'` (default)   | Forward forecast: points at ascending budgets show how delivery scales with spend   | Programmatic non-guaranteed sellers; standard "I have $X" planning  |
| `'availability'`      | Total available inventory for the targeting + dates; budget omitted                 | Guaranteed sellers' availability check before reservation           |
| `'reach_freq'`        | Points at ascending reach/frequency targets                                         | Broadcast planning — "show me cost at 75/3 vs 80/4 vs 85/5"         |
| `'clicks'`            | Points at ascending click targets                                                   | Performance campaigns specifying click goals                        |
| `'conversions'`       | Points at ascending conversion targets — **Meta-style "tell me your goal, I'll tell you the budget"** | Social platforms with goal-based optimization                       |
| `'package'`           | Each point is a distinct inventory package (Good/Better/Best, daypart, sponsorship) | Broadcast TV, audio, DOOH sellers selling packages not impressions  |
| `'weekly'` / `'daily'` | Metrics are per-period values; budget is total campaign spend                       | Period-detailed forecast for pacing analysis                        |

Buyers route on `forecast_range_unit` first to decide what the curve means before reading the points.

## What metrics you can forecast

`ForecastPoint.metrics` is keyed by metric name; values are `ForecastRange` objects (`{ low?, mid?, high? }`). Every relevant metric is wire-modeled:

- **Display / video / general**: `audience_size`, `reach`, `frequency`, `impressions`, `clicks`, `spend`, `views`, `completed_views`, `measured_impressions`
- **Social-native**: `engagements`, `follows`, `saves`, `profile_visits`
- **Broadcast / audio**: `grps`, `plays`, `downloads`
- **Outcomes** (via `additionalProperties: ForecastRange`): `purchases`, `leads`, `app_installs`, or any custom event-type your platform forecasts

Use `{ mid: value }` for point estimates; populate `low`/`high` when your forecast model expresses confidence intervals.

## Forward forecast — `'spend'` curve (sales-non-guaranteed)

Programmatic remnant. Buyer sends a brief; the seller returns products with spend curves showing the impressions/clicks/etc. trade-off across budget tiers.

```ts
getProducts: async (req, ctx) => {
  const networkCode = ctx.account.ctx_metadata.network_code;
  const products = await upstream.listProducts(networkCode);

  return {
    products: await Promise.all(products.map(async p => ({
      product_id: p.product_id,
      name: p.name,
      description: p.description,
      publisher_properties: [{ publisher_domain: p.publisher, selection_type: 'all' }],
      format_ids: p.formats.map(id => ({ agent_url: PUBLIC_AGENT_URL, id })),
      delivery_type: 'non_guaranteed',
      pricing_options: [{ pricing_option_id: 'auction', pricing_model: 'cpm', floor_price: p.floor_cpm, currency: 'USD' }],
      reporting_capabilities: { /* … */ },

      // Forward forecast — buyer's brief drives the targeting; the seller's
      // forecaster returns a 5-point curve showing impressions across spend.
      forecast: {
        forecast_range_unit: 'spend',
        method: 'historical',
        currency: 'USD',
        points: await upstream.getSpendCurve(p.product_id, req.brief),
        generated_at: new Date().toISOString(),
      },
    }))),
  };
}
```

The `points` array would shape like:

```json
[
  { "budget": 1000,  "metrics": { "impressions": { "mid": 90000 }, "clicks": { "mid": 380 } } },
  { "budget": 5000,  "metrics": { "impressions": { "mid": 460000 }, "clicks": { "mid": 1900 } } },
  { "budget": 25000, "metrics": { "impressions": { "mid": 2300000 }, "clicks": { "mid": 9400 } } },
  { "budget": 100000, "metrics": { "impressions": { "mid": 9100000 }, "clicks": { "mid": 36000 } } }
]
```

Buyers read the curve and pick a budget that hits their constraints. Curves should be **monotonic in budget** for the metrics that scale linearly; non-monotonic curves model diminishing returns or reach saturation.

## Reverse forecast — `'conversions'` / `'clicks'` / `'reach_freq'` (sales-social, performance)

The schema description literally says: *"Used in goal-based planning (e.g., Meta-style 'tell me your goal, I'll tell you the budget')."* This is the surface walled-garden Marketing APIs (Meta, TikTok, Snap, LinkedIn) spend most of their planning surface on. Project it through.

```ts
getProducts: async (req, ctx) => {
  const advertiserId = ctx.account.ctx_metadata.advertiser_id;
  const products = await upstream.listProducts(advertiserId);

  return {
    products: await Promise.all(products.map(async p => ({
      // …standard fields…
      forecast: {
        // Buyer picks a conversion target; this curve says what budget hits it.
        forecast_range_unit: 'conversions',
        method: 'modeled',
        currency: 'USD',
        points: await upstream.getReverseForecast(p.product_id, {
          targeting: req.brief,
          optimization_goal: 'conversions',
        }),
        generated_at: new Date().toISOString(),
      },
    }))),
  };
}
```

Points shape — note `metrics.spend` is the dependent variable, not the independent one:

```json
[
  { "metrics": { "purchases": { "mid": 100  }, "spend": { "low": 800,    "mid": 1200,    "high": 1800   } } },
  { "metrics": { "purchases": { "mid": 500  }, "spend": { "low": 5500,   "mid": 7500,    "high": 11000  } } },
  { "metrics": { "purchases": { "mid": 2000 }, "spend": { "low": 28000,  "mid": 38000,   "high": 55000  } } }
]
```

Buyers pick a goal (`purchases.mid`) and read the implied budget (`spend.mid`). Use `'clicks'` when the target outcome is clicks, `'reach_freq'` for broadcast frequency targets.

## Availability — `'availability'` (sales-guaranteed)

Guaranteed sellers don't sell on a spend curve — they sell reservations against committed inventory. The forecast becomes an availability check: "for this targeting and these flight dates, here's what's left." Budget is omitted; `metrics.spend` expresses the estimated cost of the available inventory.

```ts
forecast: {
  forecast_range_unit: 'availability',
  method: 'reserved_inventory',
  currency: 'USD',
  points: [{
    metrics: {
      impressions: { mid: 50_000_000 },
      audience_size: { mid: 12_000_000 },
      spend: { mid: 250_000 }, // estimated cost at the seller's rate card
    },
  }],
  valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
}
```

`valid_until` matters for guaranteed availability — inventory state ages out fast. Set it conservatively (typically 24h) and let buyers refresh by re-calling `get_products`.

## Package — `'package'` (broadcast TV, audio, DOOH)

Broadcast and DOOH sellers sell **packages**, not impressions at variable spend. Each point is a distinct package with a unique `label` and committed inventory.

```ts
forecast: {
  forecast_range_unit: 'package',
  method: 'reserved_inventory',
  currency: 'USD',
  points: [
    { label: 'Primetime Network',  metrics: { grps: { mid: 18.5 }, audience_size: { mid: 32_000_000 }, spend: { mid: 850_000 } } },
    { label: 'Daypart Mix',        metrics: { grps: { mid: 22.0 }, audience_size: { mid: 38_000_000 }, spend: { mid: 600_000 } } },
    { label: 'Late Fringe',        metrics: { grps: { mid: 8.4 },  audience_size: { mid: 14_000_000 }, spend: { mid: 180_000 } } },
  ],
  reach_unit: 'people_2plus',
  measurement_source: 'nielsen',
  demographic: 'A25-54',
}
```

Buyers pick a package by label; the seller treats the buyer's `create_media_buy` reference back to that label as the reservation request.

## Period-detailed — `'weekly'` / `'daily'`

When the buyer needs pacing analysis (frequency-per-period, per-period delivery for budget-flighting decisions), surface `weekly` or `daily` curves. Points still have `budget` (total campaign spend); metrics are per-period values.

```ts
forecast: {
  forecast_range_unit: 'weekly',
  method: 'historical',
  currency: 'USD',
  points: [{
    budget: 100_000,
    metrics: {
      impressions: { mid: 1_400_000 },  // per week
      reach: { mid: 850_000 },           // per week
      frequency: { mid: 1.65 },          // exposures per user per week
    },
  }],
}
```

Most adopters won't need this — `'spend'` covers the planning case for non-guaranteed; `'availability'` for guaranteed. `'weekly'`/`'daily'` is for pacing-aware buyers (CTV, cinema, OOH) where weekly delivery shape matters as much as totals.

## When to populate `Product.forecast` vs. omit

Populate it when:
- You can compute a meaningful curve given the buyer's brief — most sellers can for at least one `forecast_range_unit`.
- The buyer's planning question is one your platform models internally. Walled gardens absolutely do; programmatic exchanges absolutely do; data marketplaces sometimes do.

Omit it when:
- Your inventory is so commoditized that "I have $X" doesn't narrow the planning answer (most pure ad networks).
- You don't have access to the buyer's targeting details before the buy is committed (rare).

If you populate it, populate it consistently — buyers who learn one product has a forecast and another doesn't will build defensive null-checks. Either every product in a given response carries forecast, or none do; mix only when products genuinely have different forecast surfaces (some are availability-checked guaranteed, others are spend-curve non-guaranteed).

## Cross-product forecasting and competitive overlap

`Product.forecast` is per-product. It doesn't model: "if I buy product A AND product B with overlapping targeting, B's reach is reduced by N due to overlap." That's competitive forecasting — outside the per-product surface today.

Workarounds:
- For multi-product flights, surface the de-duplicated forecast at the proposal level via `Proposal.delivery_forecast` (same `DeliveryForecast` shape, scoped to the bundle).
- For intra-product line-item competition, surface the contention via `metrics.frequency` (which captures saturation effects).

If your planning surface needs first-class multi-product forecasting, file a spec issue with the use case — the AdCP-3.x extension path is open.

## Common pitfalls

1. **Returning a point at `budget: 0`**. Most curves don't extrapolate to zero meaningfully. Start at a non-zero minimum that reflects your real low-end. The schema requires `minimum: 0` (zero is allowed) but adopters who include `{ budget: 0, metrics: {...} }` get buyer-side division-by-zero on cost-per-X derivations.
2. **Forgetting `currency`**. `currency` is required on `DeliveryForecast`. Buyers can't compare forecasts across products without it.
3. **Mixing `forecast_range_unit` mid-response**. If product A has `'spend'` and product B has `'availability'`, buyers comparing them have to switch interpretation modes per product. Acceptable when the difference is genuine (guaranteed vs. non-guaranteed in the same response), confusing otherwise.
4. **Non-monotonic spend curves without explanation**. If `impressions` decreases as `budget` increases at some point, you're modeling reach saturation or competitive contention — add a `label` or `notes` (in `ext`) so buyers know it's intentional.
5. **Stale forecasts**. Set `valid_until` honestly. Availability forecasts should age out within hours; reach/forecast curves on programmatic inventory can live for days.

## Schema references

- `/schemas/3.0.4/core/delivery-forecast.json`
- `/schemas/3.0.4/core/forecast-point.json`
- `/schemas/3.0.4/core/forecast-range.json`
- `/schemas/3.0.4/enums/forecast-range-unit.json`
- `/schemas/3.0.4/enums/forecastable-metric.json`
- `/schemas/3.0.4/enums/forecast-method.json`
- `/schemas/3.0.4/enums/reach-unit.json`
- `/schemas/3.0.4/enums/demographic-system.json`

## Where this surface lights up across specialisms

| Specialism                     | Canonical `forecast_range_unit` | What the curve looks like                                         |
| ------------------------------ | ------------------------------- | ----------------------------------------------------------------- |
| `sales-non-guaranteed`         | `'spend'`                       | Programmatic forward forecast — impressions per budget tier       |
| `sales-guaranteed`             | `'availability'`                | Reserved inventory check — what's left for the targeting + dates  |
| `sales-broadcast-tv`           | `'reach_freq'` or `'package'`   | GRP curves OR daypart packages with reach/audience_size           |
| `sales-streaming-tv`           | `'reach_freq'` + `'spend'`      | CTV's hybrid — reach goals plus a spend curve                     |
| `sales-social`                 | `'conversions'` or `'clicks'`   | Goal-based: target conversions → required budget                  |
| `sales-catalog-driven`         | `'spend'` per catalog item      | Per-item performance forecast for catalog-driven dynamic ads      |
| `sales-retail-media`           | `'conversions'`                 | Outcome-based for retail media's purchase-attribution use case    |
| `sales-proposal-mode`          | varies                          | Proposal-level forecast under `Proposal.delivery_forecast`        |

Pick the unit that matches how your platform's planners actually think about inventory. If you're not sure, `'spend'` for non-guaranteed and `'availability'` for guaranteed are the safe defaults.
