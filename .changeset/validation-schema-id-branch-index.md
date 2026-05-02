---
"@adcp/sdk": patch
---

`ValidationOutcome` gains `schema_id?: string` (the root schema's `$id`). `ValidationIssue` gains `selected_branch_index?: number` on `oneOf`/`anyOf` issues where the compaction logic narrowed to a best-match branch. Pairs with `variants[]`: `variants[selected_branch_index]` is the branch the payload appeared to be targeting. Both fields are additive and non-breaking.
