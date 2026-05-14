---
'@adcp/eslint-plugin': minor
---

feat(eslint-plugin): ship `@adcp/eslint-plugin` with `no-credential-read-from-args` rule (#1541)

New workspace shipping the first build-time guard against the SDK's #1 adopter
footgun: reading credential-shaped keys off the buyer-supplied `args` bag inside
`extractContext` / `synthesizeFromArgs` platform method implementations. Build-time
sibling to the SDK's `credentialPolicy: 'authInfo-only'` runtime guard — same
regex set (imported from `@adcp/sdk/server`'s `DEFAULT_CREDENTIAL_PATTERNS`),
caught earlier. Detection is method-name keyed, not interface-type keyed, so
duck-typed `definePlatform` shapes and class methods that don't `implements`
the interface explicitly are both covered. Phase 2 (`adcp doctor` subcommand
and suggestion-level `prefer-authinfo-credential-channel` rule) tracked in #1541.
