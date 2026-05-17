---
'@adcp/sdk': minor
---

storyboard runner: add `contains:` matcher to `requires_capability` gates (#1817)

Storyboards can now gate on array-membership for capabilities whose declaration
shape is an array of allowed values:

```yaml
requires_capability:
  path: media_buy.conversion_tracking.supported_targets
  contains: 'per_ad_spend'
```

Semantics: the value at `path` MUST be an array that includes `contains` via
strict equality (no coercion). Empty arrays, non-arrays, and absent fields all
skip the storyboard with `capability_unsupported` / `unsatisfied_contract` —
absence is load-bearing, matching `present: true`. The matcher accepts a
single primitive (string, number, boolean); the array form ("ALL listed
values present") is a follow-up only if a real consumer appears.

Unblocks `performance_buy_flow_roas` (gating on `supported_targets`
including `per_ad_spend`) and the `reach_buy_flow` / `clicks_buy_flow` /
`completed_views_buy_flow` family (gating on `supported_optimization_metrics`
once that capability lands upstream).

`equals:`, `present:`, and `contains:` remain mutually exclusive on a single
gate. Existing storyboards are unchanged.
