---
"@adcp/sdk": minor
---

feat(server): add `createDynamicRegistry` for atomic hot-reloadable multi-registry bundles

Adds `createDynamicRegistry<TRegistries>()` — a factory for adopters that maintain multiple correlated Maps (adapters, v6 platforms, operational platforms, etc.) refreshed together from a config store. Centralises three atomicity lessons learned through repeated hand-rolled implementations:

1. Single-pointer bundle swap — `bundle = pending` in one synchronous statement; readers never see a half-rebuilt mix across multiple Maps.
2. In-flight refresh guard — concurrent `refresh()` calls coalesce onto the same Promise; the guard is cleared in `finally` so a thrown refresh never permanently freezes the registry.
3. Static-id carry-forward with `unregister()` denylist — `staticIds()` is polled on each refresh for ids to preserve; `unregister(id)` removes from the live bundle AND suppresses from future carry-forward.

Exported from `@adcp/sdk/server`. Replaces ~150 LOC of multi-registry plumbing per adopter deployment.
