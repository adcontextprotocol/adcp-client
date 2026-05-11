---
"@adcp/sdk": minor
---

Add `omit_account` escape hatch to `StoryboardStep` for schema_validation conformance (#1696).

Follow-up to #1683 which removed the `account_from_brand` fabrication shim: storyboard steps that deliberately test seller-side missing-account rejection could no longer reach the seller because the SDK's client-side `ValidationError` short-circuited before the wire call.

`omit_account?: boolean` on `StoryboardStep` mirrors the existing `omit_idempotency_key` pattern:

- The runner's `applyBrandInvariant` skips both the synthetic-account-construction branch and the natural-key-merge branch for the step.
- The SDK's `normalizeRequestParams` and `validateRequest` skip the `account`-required check (`skipAccountValidation` option on `TaskOptions`).
- For non-A2A runs, the raw-probe defense-in-depth path is triggered so no SDK normalization layer can silently re-inject an account before the wire call.

Without this escape hatch, conformance cannot grade "does the seller reject a missing-account `create_media_buy`?" because the client-side throw hides the spec contract from the grader.
