---
"@adcp/sdk": patch
---

Added `docs/recipes/composeMethod-testing.md` with six test patterns for `composeMethod`-wrapped handlers: mocking the base method, short-circuit assertion (including the `{ shortCircuit: undefined }` gotcha), layering two `composeMethod` calls, `after`-hook enrichment, typed-error propagation, and `requireAdvertiserMatch` with `composeMethod`. Every pattern has a corresponding running test in `test/server-decisioning-compose-recipes.test.js`. Added a `composeMethod` cookbook entry and table row to `docs/llms.txt` so agents building decisioning platforms can discover the primitive and its test patterns. Closes #1345.
