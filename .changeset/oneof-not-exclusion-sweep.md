---
'@adcp/sdk': patch
---

test(validation): broad-sweep regression coverage for the `oneOf`-`not`-keyword exclusion shipped via #1337. Closes #1383.

`compactUnionErrors` (`src/lib/validation/schema-validator.ts`) excludes `oneOf` variants whose only residual is a `not`-keyword failure when picking the "best surviving variant." The fix landed for `get_account_financials` per #1337; the same heuristic applies to every Success/Error response union in AdCP 3.x, but the prior test suite covered the canonical case only.

This change locks the universal invariant as a parameterized regression suite: for every response schema with a `not` clause in its bundled cache (25 schemas in 3.0.4), an empty-payload response surfaces zero `not`-keyword issues. Pre-#1337, those payloads would surface "must NOT be valid" diagnostics — unactionable for adopters debugging from the wire envelope.

`get_signals` and `tasks_get` are intentionally absent from the sweep — their response shapes don't use the Success/Error oneOf-with-not pattern.

Future response unions inherit the coverage automatically when added to the schema cache; the fixture list at the top of the new `describe` block is the single update point.
