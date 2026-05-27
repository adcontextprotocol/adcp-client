---
'@adcp/sdk': minor
---

feat(capabilities): project `supported_optimization_metrics` + `frequency_capping`; add catalog-rollup helper

Closes #1853 (projection gap) and #1818 (catalog rollup).

**The projection gap (#1853)**

AdCP 3.1 added two top-level `media_buy.*` capability fields:

- `supported_optimization_metrics` (adcp#4669) — seller-level rollup of optimization metrics
- `frequency_capping` (adcp#4670) — presence-only object declaring frequency-cap support

`from-platform.ts` only projected three rich blocks (`audience_targeting`, `conversion_tracking`, `content_standards`). Adopters who declared the new fields on `platform.capabilities` saw them silently dropped from the wire response. Now wired into the same `overrides.media_buy` deep-merge seam.

**Typed surface** (`DecisioningCapabilities`):

```ts
capabilities: {
  supported_optimization_metrics?: ('clicks' | 'views' | 'completed_views' | ...)[];
  frequency_capping?: {
    supported_per_units?: ('impression' | 'click')[];
    supported_window_units?: ('hour' | 'day' | 'week' | 'month')[];
  };
}
```

Both are optional. Unlike the older three blocks, **the 3.1 additions do NOT force a `features.*` boolean** — buyers gate on presence-of-block directly.

**The catalog rollup helper (#1818)**

New exported helper `rollupOptimizationMetricsFromProducts(products)` computes the seller-level union from a product catalog. Returns a sorted, deduplicated array. Adopters call it at startup or on catalog mutation to keep the seller-level declaration mechanically derived from product-level facts — closes the drift surface called out in #1818.

For `conversion_tracking.supported_targets`, the framework now defaults to `['cost_per']` whenever an adopter declares `conversion_tracking` without a `supported_targets` property. `cost_per` is the conservative event-goal target kind every conversion-tracking seller can compute; adopters must explicitly opt into `per_ad_spend` or `maximize_value` once their event-ingestion pipeline captures value fields. Explicit arrays are honored unchanged, and `supported_targets: undefined` preserves the raw AdCP omission semantics.

**Verification**

- 8 unit tests on the rollup helper (union, dedup, sort, empty, defensive-drop, non-mutating)
- 6 new integration tests on the projection
- All affected tests pass; `tsc --noEmit --project tsconfig.lib.json` clean

Part of the 8.1.0-beta.N adoption sweep.
