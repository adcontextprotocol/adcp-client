---
"@adcp/sdk": minor
---

Add `resolveWithoutRef` option to `RosterAccountStoreOptions`. When set, ref-less `accounts.resolve(undefined, ctx)` calls (from `list_creative_formats`, `provide_performance_feedback`, `preview_creative`, and discovery-phase tools) are routed through the hook then through `toAccount`, enabling a synthetic publisher-wide singleton without overriding `resolve` on the returned store. When omitted, existing behavior is unchanged (`null` returned for ref-less calls). Also adds a `## Ref-less resolution` section to `docs/guides/account-resolution.md`.
