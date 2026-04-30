---
"@adcp/sdk": patch
"@adcp/client": patch
---

fix(validation): filter oneOf branch sub-errors from Ajv output

Ajv with `allErrors:true` emits per-branch `required`/`type` errors from
every non-matching `oneOf` variant alongside the top-level `oneOf` node
error. These sub-branch errors appeared as spurious validation failures
(e.g. "/products/2/name: must have required property 'name'") even when
data was schema-valid, causing storyboard CI to report false-negative
failures for downstream SDKs (adcp-client#1111).

The fix post-filters `validator.errors` in `validateResponse` and
`validateRequest` to drop any error whose `schemaPath` is a strict
descendant of a failing `oneOf` node's path. The `oneOf` node error
itself is preserved and enriched with `variants[]` by the existing
`enrichWithVariants` helper. `anyOf` sub-errors are intentionally not
filtered — `anyOf` allows partial matches and its sub-errors carry useful
disambiguation signal.
