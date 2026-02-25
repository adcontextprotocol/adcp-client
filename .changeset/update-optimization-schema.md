---
"@adcp/client": minor
---

Updated optimization schema: `OptimizationGoal` is now a `oneOf` with `metric` (seller-tracked delivery metrics) and `event` (advertiser-tracked conversions) variants, supporting multiple event sources and priority ordering. `Package.optimization_goal` renamed to `optimization_goals` (array). `supported_optimization_strategies` enum updated. Also adds `get_account_financials` tool and `BrandID`/`BrandReference`/`AccountReference` types from upstream schema sync.
