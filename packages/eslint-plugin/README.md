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
      accountId: args.account_id,           // non-secret upstream ID
      token: tokenCache.get(ctx.authInfo),  // secret comes from authInfo
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
