---
"@adcp/sdk": minor
---

feat(server): variadic `composeMethod(inner, ...hooks)` overload for stacking multiple guards without nesting

Adds a variadic form of `composeMethod` so adopters can write `composeMethod(inner, hookA, hookB, hookC)` instead of `composeMethod(composeMethod(composeMethod(inner, hookC), hookB), hookA)`. Semantics are identical to right-to-left manual nesting: `before` hooks run left-to-right, `after` hooks run right-to-left. The two-argument form is unchanged.

Also adds a "When to use which approach" decision matrix to `docs/recipes/composeMethod-testing.md` covering preset-vs-inline tradeoffs, the `requireOrgScope` undefined-org gotcha, and `onDeny` evaluation-order implications.

Closes #1444.
