---
"@adcp/sdk": patch
---

Storyboard runner: ensure synthetic `AccountReference` natural-key refs always carry `operator` so a strict-validating seller can't reject them. Closes #1419.

The natural-key arm of `AccountReference` requires `operator` per `core/account-ref.json`. Three runner-side synthesis sites could previously produce `{brand, sandbox}` without `operator` — the SDK's loose runtime decoder hid the gap, but a spec-conformant seller running schema-strict validation would reject the ref:

- `applyBrandInvariant` (`runner.ts`) — when merging brand into a fixture's natural-key account, default `operator` to `brand.domain` if absent.
- `comply_test_controller` enricher (`request-builder.ts`) — when `context.account` was a natural-key ref missing `operator`, default to `brand.domain` before forcing `sandbox: true`.
- `sync_accounts` context extractor (`context.ts`) — drop `operator` from the propagated account ref when the response leaves it undefined, instead of writing `operator: undefined` (which `JSON.stringify` silently strips on the wire). The `{account_id}` arm and adopter-supplied operators are unaffected.
