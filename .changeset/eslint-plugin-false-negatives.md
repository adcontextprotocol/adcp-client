---
'@adcp/eslint-plugin': patch
---

fix(eslint-plugin): close destructure / default-param / nested destructure false-negatives + `additionalPatterns` option (#1758)

Three bug-class false-negatives in `no-credential-read-from-args` now fire:

- **Destructure-then-read** — `extractContext(args) { const { access_token } = args; ... }` (added `VariableDeclarator` visitor; recurses through nested `ObjectPattern`s and reports at the source key, not the alias).
- **AssignmentPattern default-value silently disabled scanning** — `extractContext(args = {}) { args.access_token }` now unwraps `AssignmentPattern.left` in `firstParamIdentifierName`. `extractContext({ access_token } = {})` likewise.
- **Nested destructure in first param** — `extractContext({ context: { access_token } })` now recurses and reports the full dotted path (`args.context.access_token`). Nested renames (`{ context: { access_token: tok } }`) fire on the source key.

New `additionalPatterns` rule option lets adopters who extend the runtime matcher via `credentialPolicy.patterns.extend(...)` mirror the same strings at lint time. Compiled with the `i` flag and appended to `DEFAULT_CREDENTIAL_PATTERNS`. Fully-replaceable `credentialPolicy.matcher` functions stay a documented gap.

False-positive fix: free-standing `function extractContext(args) { ... }` no longer fires — only object-literal `Property` and class-body `MethodDefinition` method bindings are matched. Class methods still fire (regression-covered).

README adds a `Known gaps` section documenting aliasing / spread / helper-indirection / computed-key / cross-function bypasses that pass the linter by design; runtime `credentialPolicy: 'authInfo-only'` is the security boundary that catches all of them at dispatch.

Test count: 14 → 30.
