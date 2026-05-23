---
'@adcp/sdk': patch
---

fix(storyboard): add `schemaDeclaresTopLevelField` to gate brand/account injection on schema `properties` (#1955)

AdCP 3.1.0-beta.3 set `additionalProperties: true` on all mutating request schemas (vendor-extension friendly). The existing `schemaAllowsTopLevelField` helper, which gated `brand` and `account` injection in the storyboard runner, relied on `additionalProperties: false` to detect tools that explicitly list a field — with `additionalProperties: true` everywhere it now returns `true` for every field on every tool, causing the runner to inject `brand` into tools like `sync_plans` that don't declare it.

Adds `schemaDeclaresTopLevelField` which checks `'field' in schema.properties` regardless of `additionalProperties`. Updates the runner's `applyBrandInvariant` to use the new function for `brand` and `account` injection gates. Removes the now-dead `schemaAllowsTopLevelField` guard from `applyDisableSandboxHint` (the `ext` channel is accepted on every tool since `additionalProperties: true` is universal — the guard was always true and never fired). Updates the brand-invariant test suite to use `schemaDeclaresTopLevelField` and fix the inter-test assignment sequencing via a `before()` hook.

Fixes 3 failing tests in `test/lib/storyboard-brand-invariant.test.js`.
