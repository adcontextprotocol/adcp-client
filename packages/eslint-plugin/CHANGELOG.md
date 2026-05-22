# @adcp/eslint-plugin

## 0.1.2

### Patch Changes

- Updated dependencies [4cb1620]
- Updated dependencies [2c3b589]
- Updated dependencies [93d390d]
  - @adcp/sdk@8.0.0

## 0.1.1

### Patch Changes

- 7ef52ba: chore(eslint-plugin): pin `publishConfig.access` to `public`

  Adds `"publishConfig": { "access": "public" }` to `packages/eslint-plugin/package.json`. The 0.1.0 release workflow first-publish failed with `E404` because npm defaults brand-new scoped packages to **restricted** access, which requires either a paid org or an explicit `--access public` flag. With `publishConfig.access` set, future automated `changeset publish` runs publish the package as public without needing the CLI flag — same posture as `@adcp/sdk`, which has been public since first publish.

  No runtime change. Rule logic, exports, and dependencies are unchanged.

- Updated dependencies [2c718a5]
- Updated dependencies [2c718a5]
  - @adcp/sdk@7.5.0

## 0.1.0

### Minor Changes

- 4d54139: feat(eslint-plugin): ship `@adcp/eslint-plugin` with `no-credential-read-from-args` rule (#1541)

  New workspace shipping the first build-time guard against the SDK's #1 adopter
  footgun: reading credential-shaped keys off the buyer-supplied `args` bag inside
  `extractContext` / `synthesizeFromArgs` platform method implementations. Build-time
  sibling to the SDK's `credentialPolicy: 'authInfo-only'` runtime guard — same
  regex set (imported from `@adcp/sdk/server`'s `DEFAULT_CREDENTIAL_PATTERNS`),
  caught earlier. Detection is method-name keyed, not interface-type keyed, so
  duck-typed `definePlatform` shapes and class methods that don't `implements`
  the interface explicitly are both covered. Phase 2 (`adcp doctor` subcommand
  and suggestion-level `prefer-authinfo-credential-channel` rule) tracked in #1541.

### Patch Changes

- 569e97c: fix(eslint-plugin): close destructure / default-param / nested destructure false-negatives + `additionalPatterns` option (#1758)

  Three bug-class false-negatives in `no-credential-read-from-args` now fire:
  - **Destructure-then-read** — `extractContext(args) { const { access_token } = args; ... }` (added `VariableDeclarator` visitor; recurses through nested `ObjectPattern`s and reports at the source key, not the alias).
  - **AssignmentPattern default-value silently disabled scanning** — `extractContext(args = {}) { args.access_token }` now unwraps `AssignmentPattern.left` in `firstParamIdentifierName`. `extractContext({ access_token } = {})` likewise.
  - **Nested destructure in first param** — `extractContext({ context: { access_token } })` now recurses and reports the full dotted path (`args.context.access_token`). Nested renames (`{ context: { access_token: tok } }`) fire on the source key.

  New `additionalPatterns` rule option lets adopters who extend the runtime matcher via `credentialPolicy.patterns.extend(...)` mirror the same strings at lint time. Compiled with the `i` flag and appended to `DEFAULT_CREDENTIAL_PATTERNS`. Fully-replaceable `credentialPolicy.matcher` functions stay a documented gap.

  False-positive fix: free-standing `function extractContext(args) { ... }` no longer fires — only object-literal `Property` and class-body `MethodDefinition` method bindings are matched. Class methods still fire (regression-covered).

  README adds a `Known gaps` section documenting aliasing / spread / helper-indirection / computed-key / cross-function bypasses that pass the linter by design; runtime `credentialPolicy: 'authInfo-only'` is the security boundary that catches all of them at dispatch.

  Test count: 14 → 30.

- Updated dependencies [c02406a]
- Updated dependencies [7a6a6c9]
- Updated dependencies [cfa6a0f]
- Updated dependencies [098f497]
- Updated dependencies [bea09b9]
- Updated dependencies [7c88567]
- Updated dependencies [c867257]
- Updated dependencies [98b52eb]
- Updated dependencies [286716b]
- Updated dependencies [68dacf2]
- Updated dependencies [8f3511d]
- Updated dependencies [09ff76b]
- Updated dependencies [db59a53]
- Updated dependencies [4348d51]
- Updated dependencies [b7aed85]
- Updated dependencies [22f5cd4]
- Updated dependencies [eb0cede]
- Updated dependencies [ba56164]
- Updated dependencies [7fe990c]
- Updated dependencies [12e4a7f]
- Updated dependencies [f24f6d0]
  - @adcp/sdk@7.4.0
