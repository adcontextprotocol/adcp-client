---
'@adcp/sdk': minor
---

Default `media_buy.conversion_tracking.supported_targets` to `["cost_per"]` when adopters declare conversion tracking without an explicit target list. Explicit `supported_targets` arrays are preserved unchanged, and `supported_targets: undefined` preserves the raw AdCP omission semantics for adopters that need the best-effort target signal.
