---
"@adcp/sdk": patch
---

Fix storyboard runner emitting spec-invalid `AccountReference` (missing `operator`) for cascade scenarios. Closes #1419.

`applyBrandInvariant` now ensures the `operator` field is always present on natural-key `AccountReference` objects in outgoing storyboard requests. When `operator` is absent or `undefined` (e.g. from a `sync_accounts` context where the upstream response omitted the field), it falls back to `brand.domain` — the same value `resolveAccount()` uses for synthetic sandbox refs, and consistent with the spec's description of the field ("when the brand operates directly, this is the brand's domain").

The companion fix in the `sync_accounts` context extractor avoids storing `{operator: undefined}` in `StoryboardContext.account` in the first place, eliminating a latent footgun for any future code path that consumes `context.account` without going through `applyBrandInvariant`.

**Impact:** Sellers that run strict schema validation (AJV in strict mode, or any validator that honors `account-ref.json`'s `oneOf` `required` constraint) previously rejected synthetic `comply_test_controller` calls in cascade scenarios, causing all cascade scenario steps to fail with a validation error rather than the expected functional response. After this fix, the runner emits a fully spec-valid `AccountReference` on every outgoing request.
