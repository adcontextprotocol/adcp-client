---
'@adcp/client': minor
---

Add response helpers and shape-drift detection for governance list tools (closes #854):

**New response helpers** in `@adcp/client/server`:

- `listPropertyListsResponse(data)` — wraps `{ lists: PropertyList[] }`
- `listCollectionListsResponse(data)` — wraps `{ lists: CollectionList[] }`
- `listContentStandardsResponse(data)` — handles the union type (success `{ standards }` / error `{ errors }`)

All three follow the existing list-response pattern (`listCreativesResponse` / `listAccountsResponse`): default summary names the count and singular/plural handling, pass-through of the typed payload into `structuredContent`.

**Shape-drift detection** — `list_property_lists`, `list_collection_lists`, and `list_content_standards` now join the `LIST_WRAPPER_TOOLS` table in the storyboard runner's `detectShapeDriftHint`. A handler that returns a bare array at the top level gets a pointed hint naming the correct wrapper key and the new helper.

Brings the shape-drift detector's coverage of list tools to nine: `list_creatives`, `list_creative_formats`, `list_accounts`, `get_products`, `get_media_buys`, `get_signals`, and now the three governance tools. 34 shape-drift tests + 3 new response-helper tests covering count-formatting and the error-branch split on content standards.
