---
"@adcp/sdk": patch
---

fix(validation): oneOf near-miss diagnostics now surface the correct variant

When a handler returns a response with `undefined` fields that JSON.stringify
silently drops, the response validator now surfaces the *success* variant's
missing required fields instead of the error variant's `not`-clause rejection.

Previously, `compactUnionErrors` chose the "best" variant by raw residual
error count. An error variant with a single root-level `not` error (1 residual)
beat the success variant with two `required` failures (2 residuals), producing
a misleading `must NOT be valid` diagnostic that pointed adopters to the wrong
variant entirely.

The fix adds a priority rule: variants whose *only* residuals are `not`-keyword
errors at the root instance path are deprioritised over variants that have at
least one non-`not` residual. The `not`-penalty is scoped to root-level `not`
errors to avoid affecting schemas that use `not` as a discriminator deeper in
the tree.

Additionally, the server's response-validation block now logs a developer-
facing warning for any `undefined`-valued fields in the handler response before
the schema validator runs. This intercepts the root cause (undefined keys that
stringify will drop) and names the affected JSON Pointer paths in the same log
flush as the schema error.
