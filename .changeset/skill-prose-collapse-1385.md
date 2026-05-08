---
"@adcp/sdk": patch
---

docs(skills): collapse signal/creative/seller specialism skills onto fork-target pointers

In-scope subset of #1385. Skills with a worked-example adapter now reduce to a fork-target pointer plus this-specialism's deltas, instead of duplicating inline pattern teaching.

- `signal-marketplace` + `signal-owned`: restructured to fork-target + delta sections
- `creative-generative`: points at `creative-template` adapter; adds delta-only generative section
- `sales-broadcast-tv`, `sales-streaming-tv` (new), `sales-catalog-driven` + `sales-retail-media`, `audience-sync` (-46 lines / 60% reduction), `sales-proposal-mode`: each adopts the fork-target shape

No behavior change.
