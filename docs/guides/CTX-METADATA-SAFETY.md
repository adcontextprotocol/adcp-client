# What goes in `ctx_metadata` (and what doesn't)

`ctx_metadata` is the framework's adopter-internal bag on every
`DecisioningPlatform` resource — `Account`, `Product`, `MediaBuy`,
`Package`, `Creative`, `Audience`, `Signal`. The framework doesn't read
its contents; it strips it from wire responses; adopters use it to thread
upstream IDs and platform-internal state through the dispatcher seam.

The strip-on-wire is necessary but not sufficient. This guide covers what
that means in practice and how to keep credentials out of your logs.

## TL;DR

- The framework strips `ctx_metadata` from **wire responses** to buyers.
- The framework does NOT strip it from **server-side log lines, error
  envelopes (when `exposeErrorDetails: true`), heap dumps, or strings
  your own code constructs**.
- Treat `ctx_metadata` as if every value will eventually appear in a log
  line. Put non-secret state there.

## Safe to put in `ctx_metadata`

- Upstream platform IDs (GAM `networkId` / `advertiserId`, Spotify
  `brandId` / `businessId`, Criteo `customerId`, Snap `act_<id>`)
- Pre-computed lookup keys
- Non-sensitive feature flags (`isPremium`, `currency`, regional codes)
- Anything you'd be comfortable seeing in a debug log

## Do NOT put in `ctx_metadata`

- Bearer tokens (`accessToken`, `apiToken`, `bearerToken`)
- OAuth refresh tokens
- API keys, client secrets
- Passwords, password hashes
- Anything matching `/(token|secret|key|password|credential|authorization|bearer)/i`
- Anything that, leaked to an operator log, would be a security incident

## Why the wire-strip isn't enough

Three leak surfaces exist beyond the wire response:

### 1. Adopter-generated error messages

```ts
// ❌ Leaks ctx_metadata.accessToken to the buyer when exposeErrorDetails: true,
//    and to your server log unconditionally.
async getProducts(req, ctx) {
  try {
    return await upstream.fetch('/products', { auth: ctx.account.ctx_metadata.accessToken });
  } catch (err) {
    throw new Error(`upstream call failed for account ${JSON.stringify(ctx.account)}`);
  }
}
```

The framework's `redactCredentialPatterns` will catch literal `Bearer
<token>` shapes in the message string, but it can't see into a
`JSON.stringify(account)` blob whose key happens to be `accessToken`.

### 2. Info-level structured logs

```ts
// ❌ Most logger libraries serialize the whole object; ctx_metadata flows
//    into your logging pipeline (Datadog, CloudWatch, etc.) verbatim.
logger.info('resolving product', { account: ctx.account, productId });
```

### 3. Heap dumps and process inspection

A core dump or `util.inspect(framework)` walks every reachable property,
including `ctx_metadata` on cached `Account` objects. Tokens at rest in
process memory are recoverable.

## Recommended pattern: re-derive bearers per request

Don't embed the bearer in `ctx_metadata`. Re-derive it in each tool
method from the framework-provided `ctx.authInfo` (or from your own
per-principal token cache keyed off the resolved account id):

```ts
// ✅ ctx_metadata holds upstream IDs only.
resolve: async (ref, ctx) => ({
  id: matchedRow.id,
  name: matchedRow.name,
  status: 'active',
  ctx_metadata: { upstreamId: matchedRow.id, networkId: matchedRow.network_id },
});

// In each tool method, fetch the bearer once per request from your cache.
getProducts: async (req, ctx) => {
  const tok = await tokenCache.getForAccount(ctx.account.id, ctx.authInfo);
  return await upstream.fetch('/products', { auth: tok });
}
```

Token caches keyed off the framework-provided principal (`ctx.authInfo`)
are exactly the surface `accounts.refreshToken` exists for — see the
`AccountStore.refreshToken` JSDoc for the canonical refresh hook.

## When you must pass an upstream credential downstream

Some tool methods need the bearer in flight (long-running operations
that span multiple framework callbacks). For those, prefer
`Account.authInfo.token` over `ctx_metadata.accessToken`:

- The framework auto-attaches `authInfo` from `serve({ authenticate })`
  when adopters omit it (`account.ts:182-194`).
- The framework's `refreshToken` hook mutates `account.authInfo.token`
  and `expiresAt` after a successful refresh — single-source-of-truth
  for the active credential.
- `authInfo` is stripped from the wire alongside `ctx_metadata`, but
  the convention "credentials live on `authInfo`" makes adopter code
  reviews more reliable than scanning every `ctx_metadata` field.

## Forward compatibility

The SDK may grow an optional Zod / standard-schema declaration that the
framework uses for structural redaction (key marked `.sensitive()`
gets redacted from log lines automatically). Until that lands, the
discipline is the doc above. See [#1343][issue] for the design thread.

## Verifying the strip works

Sanity test for your platform:

```ts
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';

const server = createAdcpServerFromPlatform(myPlatform, opts);
const result = await server.dispatchTestRequest({ /* ... */ });
const wire = JSON.stringify(result.structuredContent);
assert(!wire.includes('SENTINEL_VALUE_FROM_CTX_METADATA'));
```

This catches accidental wire leaks where an adopter spreads
`ctx_metadata` into a response shape (don't do that).

[issue]: https://github.com/adcontextprotocol/adcp-client/issues/1343
