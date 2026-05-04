---
"@adcp/sdk": patch
---

fix(server): createDynamicRegistry — clear stale pin on overwrite; add `has()` method

`register(..., { overwrite: true })` without `{ pinned: true }` no longer carries the previous pin forward through the next `refresh()`. Adds `DynamicRegistry.has(name, id)` for cheap presence checks. Adds JSDoc note that `registries` must be passed `as const` to preserve per-registry value types.
