---
"@adcp/sdk": patch
---

`compactUnionErrors` now excludes `oneOf` variants that emitted a `not` keyword failure when picking the "best surviving variant." A variant that failed via `not: { required: [...] }` rejected the payload by design — the adopter's actionable lever is the OTHER variant's residuals (missing required they need to add), not the path the `not` clause closed. Closes #1337.

Concretely: for `get_account_financials` Success-vs-Error oneOf where the payload populates the Success-only fields but is missing `currency` / `timezone`, the validator now surfaces "missing required property `currency`" pointing at the Success variant (`#/oneOf/0/required`) instead of the unactionable "must NOT be valid" (`#/oneOf/1/not`) plus "must have required property `errors`" from the Error variant. Same diagnostic shape applies to every Success/Error response oneOf in AdCP 3.x (which is most of them).

If every variant has a `not` failure (contrived schema), the picker falls back to the existing fewest-residuals heuristic so degenerate cases still produce a diagnostic.
