---
'@adcp/client': patch
---

Extend `detectShapeDriftHint` in the storyboard runner to cover list-shaped tools (closes #852):

- `list_creatives` — handler returns bare `[{...}]` instead of `{ creatives, query_summary, pagination }`
- `list_creative_formats` — bare array instead of `{ formats: [...] }`
- `list_accounts` — bare array instead of `{ accounts: [...] }`
- `get_products` — bare array instead of `{ products: [...] }`

The detector now accepts `unknown` rather than `Record<string, unknown>` so it can recognize bare-array responses at the root — a common drift class where AJV's error ("expected object, got array") doesn't name the required wrapper key. Each known list tool gets a pointed hint naming the wrapper and the response helper (`listCreativesResponse`, `listCreativeFormatsResponse`, `listAccountsResponse`, `productsResponse`) from `@adcp/client/server`.

Bare arrays for unknown task names pass through silently — the detector only fires on registered list tools to avoid false positives on APIs that legitimately return top-level arrays.

8 new tests covering each tool, the wrapper-present negative case, unknown-task pass-through, empty-array handling, and null/primitive defensive cases.
