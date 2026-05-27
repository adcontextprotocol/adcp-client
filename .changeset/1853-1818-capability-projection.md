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

The `conversion_tracking.supported_targets` portion of #1818 is handled by the broader 3.1 unblock changeset: explicit seller declarations are preserved, while omitted values stay omitted because the 3.1 schema only guarantees target-less event goals by default.

**Verification**

- 8 unit tests on the rollup helper (union, dedup, sort, empty, defensive-drop, non-mutating)
- 3 new integration tests on the projection
- All 25 affected tests pass; `tsc --noEmit --project tsconfig.lib.json` clean

Part of the 8.1.0-beta.N adoption sweep.
