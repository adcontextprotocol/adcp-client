# @adcp/eslint-plugin

Build-time lint rules for [@adcp/sdk](https://www.npmjs.com/package/@adcp/sdk)
adopters. Catches the credential-handling antipatterns that the SDK's runtime
guards already flag, but at code-write time — so the bug never ships.

## Install

```sh
npm i -D @adcp/eslint-plugin eslint
```

## Wire up

**Flat config** (`eslint.config.js`):

```js
import adcp from '@adcp/eslint-plugin';

export default [
  {
    plugins: { '@adcp': adcp },
    rules: {
      '@adcp/no-credential-read-from-args': 'error',
    },
  },
];
```

**Legacy `.eslintrc`**:

```json
{
  "plugins": ["@adcp"],
  "extends": ["plugin:@adcp/recommended"]
}
```

## Rules

### `@adcp/no-credential-read-from-args`

Flags reads of credential-shaped keys off the buyer-supplied `args` bag
inside `extractContext` / `synthesizeFromArgs` platform method
implementations.

```ts
// ❌ flagged
const platform = {
  extractContext(args) {
    return { token: args.snap_access_token };
  },
};

// ✅ ok — re-derive bearers from authInfo + token cache
const platform = {
  extractContext(args, ctx) {
    return {
      accountId: args.account_id, // non-secret upstream ID
      token: tokenCache.get(ctx.authInfo), // secret comes from authInfo
    };
  },
};
```

Detection keys on **method name**, not interface type — duck-typed
`definePlatform` shapes and class methods that don't `implements` the
interface explicitly are both covered.

Credential-name patterns are imported directly from
[`@adcp/sdk/server`](https://github.com/adcontextprotocol/adcp-client/blob/main/src/lib/server/credential-policy.ts)'s
`DEFAULT_CREDENTIAL_PATTERNS`. The runtime guard
(`credentialPolicy: 'authInfo-only'`) and this rule share one regex set —
adding a pattern to the SDK surfaces it here automatically.

#### Option: `additionalPatterns`

Adopters who extend the runtime matcher with `credentialPolicy.patterns.extend`
can mirror the same strings here for lint parity:

```js
// eslint.config.js
import adcp from '@adcp/eslint-plugin';

export default [
  {
    plugins: { '@adcp': adcp },
    rules: {
      '@adcp/no-credential-read-from-args': [
        'error',
        { additionalPatterns: ['platform_session_key', 'vendor_bearer'] },
      ],
    },
  },
];
```

```ts
// matching runtime config — keep the two lists in sync
createAdcpServer({
  credentialPolicy: {
    mode: 'authInfo-only',
    patterns: DEFAULT_CREDENTIAL_PATTERNS.extend(['platform_session_key', 'vendor_bearer']),
  },
});
```

Each entry is compiled as `new RegExp(pattern, 'i')` and appended to
`DEFAULT_CREDENTIAL_PATTERNS`. A fully-replaceable `credentialPolicy.matcher`
function has no lint analogue — see [Known gaps](#known-gaps).

## Known gaps

This rule is a code-write-time nudge, not the security boundary. The SDK's
runtime guard (`credentialPolicy: 'authInfo-only'`) is what enforces the
contract on the wire. The patterns below intentionally pass the linter
because catching them at AST time would require cross-function or
control-flow analysis and the false-positive cost is too high; the
runtime guard catches all of them at dispatch.

- **Aliasing** — `const a = args; a.access_token` (the rule only scans
  reads rooted at the `args` parameter name).
- **Spread** — `const ctx = { ...args }; ctx.access_token` (same — `ctx`
  isn't `args`).
- **Helper indirection** — `extractField(args, 'access_token')` (the
  credential string lives in a sibling-function argument; cross-function
  scope is out of scope).
- **Computed access with a non-literal key** — `args[someVar]` (the rule
  can't statically evaluate the key).
- **Credential reads inside helper functions called from
  `extractContext`** — only the body of the flagged method itself is
  scanned; helpers it calls are not (cross-function scope).
- **A fully-replaceable `credentialPolicy.matcher`** — function matchers
  can't be expressed as a regex pattern list, so `additionalPatterns`
  can't mirror them. If you replace the matcher entirely at runtime,
  add explicit `additionalPatterns` entries here for the names you want
  flagged at lint time.

For all of the above, rely on `credentialPolicy: 'authInfo-only'` at the
request boundary — it doesn't care how the read was spelled in source.

## Why this exists

The SDK already enforces credential discipline at the request boundary via
`createAdcpServer({ credentialPolicy: 'authInfo-only' })`, which rejects
incoming requests that smuggle credential-shaped keys through the `args`
bag. That runtime guard catches mistakes at dispatch time.

This plugin catches the same class of mistake earlier — at code-write
time, in the editor, in CI, before the code is deployed. Same regex set,
different boundary.

See [`docs/guides/CTX-METADATA-SAFETY.md`](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/CTX-METADATA-SAFETY.md)
for the broader credential-discipline guidance.

## Phase 2

Phase 1 (this release) ships the `no-credential-read-from-args` rule.
Phase 2 (tracked in
[#1541](https://github.com/adcontextprotocol/adcp-client/issues/1541))
will add an `adcp doctor` CLI subcommand that wraps the linter for
adopters who don't already run ESLint, and a suggestion-level
`prefer-authinfo-credential-channel` rule with autofix hints.
