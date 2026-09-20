---
'@adcp/sdk': patch
---

Keep content-digest acceptance, mismatch, and malformed-header vectors graded
when the selected request-signing verifier profile allows either covered or
uncovered requests. Only vectors whose expected outcome depends on a stricter
content-digest policy are skipped.
