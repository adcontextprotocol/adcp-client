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

### 4. Compliance failure envelopes (`adcp_error`)

When a storyboard step fails, the SDK forwards the seller's structured
`adcp_error` into `ComplianceResult.failures[].adcp_error`. That field
is read by AAO graders, compliance dashboards, and any LLM
self-correction loop consuming the result JSON — and it persists in
grader archives longer than the originating request.

The spec-defined fields are safe: `code` (an enum), `field` (a schema
path), and structured validation issues carry no adopter secrets by
construction.

**Do not** interpolate the following into `message` or `details`:

- Bearer tokens or request-signing material (e.g. `"upstream rejected: Bearer <tok>"`)
- Internal account IDs that cross tenant boundaries
- Proprietary path fragments or hostnames from internal infrastructure

Keep `message` and `details` to spec-defined codes and field paths. For
richer internal context, write to your tenant-isolated log sink (see
[§ Info-level structured logs](#2-info-level-structured-logs) above) —
not the error envelope. See
[Sanitizing error details with `pickSafeDetails`](../../skills/build-decisioning-platform/advanced/REFERENCE.md#sanitizing-error-details-with-picksafedetails)
for the explicit-allowlist pattern that keeps `details` wire-safe.

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

## Defense in depth: `credentialPolicy` (#1529)

`ctx_metadata` discipline keeps your own server-side state clean.
**`credentialPolicy`** keeps the *buyer* from injecting credentials
through the request body in the first place — the bug class observed
across three rounds of review on PR scope3data/agentic-adapters#248,
where storefront fan-out paths read `args.<platform>_access_token`
(top-level), `args.context.<platform>_access_token` (round-2), and
`args.ext.<platform>_access_token` (round-3) under the storefront's TLS
and IP reputation. Confused-deputy by default.

The three vectors as concrete payloads — what `'authInfo-only'`
rejects:

```jsonc
// Round-1: top-level credential
{
  "media_buy_id": "mb_123",
  "paused": true,
  "snap_access_token": "<attacker-PAT>"
}

// Round-2: nested in `context`
{
  "media_buy_id": "mb_123",
  "context": { "linkedin_access_token": "<attacker-PAT>" }
}

// Round-3: nested in `ext`
{
  "media_buy_id": "mb_123",
  "ext": { "tiktok_access_token": "<attacker-PAT>" }
}
```

All three reject with `PERMISSION_DENIED` (`details.scope: 'credentials'`,
`recovery: 'correctable'`) and `details.credential_paths` listing the
offending paths (values are not echoed back). The code is
`PERMISSION_DENIED` rather than `INVALID_REQUEST` because the request
is *schema-valid* — every AdCP request schema sets `additionalProperties:
true` — and what's refused is the seller policy "credentials must
arrive on `authInfo`."

Opt in at server construction:

```ts
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';

createAdcpServerFromPlatform(platform, {
  name: 'My Agent',
  version: '1.0.0',
  credentialPolicy: 'authInfo-only',
});
```

The framework scans every incoming request's args bag for credential-
shaped keys at any depth. Default patterns cover the common credential
vocabulary: `_token`, `_secret`, `_password`, `api_key`, `private_key`,
`authorization`, `cookie`, `bearer`, `accessToken`, `refreshToken`
(case-insensitive). Hits reject with `PERMISSION_DENIED` listing the
offending paths (not values, and the rejection envelope deliberately
skips `params.context` echo so the credential doesn't round-trip through
the response).

Customize patterns when your platform vocabulary needs more:

```ts
credentialPolicy: {
  policy: 'authInfo-only',
  patterns: {
    extend: [/^bearer$/i, /credentials/i, /Pat$/],
    // or fully replace:
    // matcher: (key, path) => mySanctionedKeys.has(key),
  },
}
```

Per-tool overrides for the rare legitimate buyer-creds tool. Two
shapes — pick the narrowest exception that works:

```ts
// Coarse: this tool legitimately reads multiple credential keys.
// Every credential-shaped key passes the scan (including names you
// didn't anticipate — `password`, `client_secret`, etc.).
credentialPolicy: {
  policy: 'authInfo-only',
  tools: { legacy_tool: 'lax' },
}

// Granular: this tool reads ONE specific credential field, by name.
// Only the listed paths pass the scan; other credential-shaped keys
// still reject. Recommended over 'lax' wherever feasible — defense
// in depth scales with the size of the exception.
credentialPolicy: {
  policy: 'authInfo-only',
  tools: {
    activate_signal: { allow: ['delivery.api_token'] },
    legacy_partner: { allow: ['partner_secret', 'context.partner_secret'] },
  },
}
```

Allowlist entries are exact-match dotted paths — the same shape the
scanner emits in `details.credential_paths`. Top-level fields are bare
names; nested fields use dots; array elements use numeric indices.
A typo in the allowlist won't match the actual path the scanner
produces, so the reject still fires (the adopter sees the rejection
in dev and notices the typo).

The blessed credential channel remains `authInfo` (resolved by the
framework's authenticator). Anything that arrives on the args bag is
either a buyer-supplied non-secret OR a smuggled credential — the
policy refuses to disambiguate.

#### Build-time sibling: `@adcp/eslint-plugin` (#1541)

`credentialPolicy: 'authInfo-only'` catches credential-bag reads at
dispatch. `@adcp/eslint-plugin` catches the same antipattern earlier —
at code-write time, in the editor, in CI — by flagging any read of a
credential-shaped key off `args` inside `extractContext` /
`synthesizeFromArgs`. Same regex set (imported from `@adcp/sdk/server`'s
`DEFAULT_CREDENTIAL_PATTERNS`), two boundaries. Install with
`npm i -D @adcp/eslint-plugin` and wire the `recommended` config; see
`packages/eslint-plugin/README.md` for the wire-up snippet. Phase 2 (an
`adcp doctor` subcommand for adopters who don't run ESLint) is tracked
in #1541.

### Operational fan-out: `WireSafe<T>` + `pickWireSpecFields` (L2 of #1529)

`credentialPolicy` is enforced at the *buyer-facing* dispatch boundary
— the request the buyer sends to the storefront. Storefronts that
fan-out to N upstream platforms still need to scrub buyer-controlled
input before forwarding it to each upstream, and that scrub happens
*after* the dispatcher has already cleared the credential-policy gate.

**`pickWireSpecFields(req, schemaName)`** is the typed boundary at
that downstream point. It strips a buyer request to the AdCP wire-
spec field allowlist for the named request type and returns the
result branded `WireSafe<T>`. The brand is what makes the discipline
load-bearing: code that spreads a buyer request directly cannot
satisfy the brand. `{ ...buyerReq }` is `T`, not `WireSafe<T>`, so
passing it where `WireSafe<T>` is required is a compile error.

```ts
import { pickWireSpecFields, scrubExtensions } from '@adcp/sdk/server';

// Buyer-facing handler (the storefront-side `sales.updateMediaBuy`)
async updateMediaBuy(buyerReq, ctx) {
  // Strip to wire-spec fields. Drops top-level credentials,
  // unknown keys, account-pivot fields not in the spec.
  const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');

  // Per-target: filter ext/context to a known-safe key set, inject
  // storefront-resolved credentials.
  const targets = await resolveTargets(buyerReq, ctx);
  for (const target of targets) {
    const perTarget = scrubExtensions(safe, {
      allowedExtKeys: new Set(['scope3_api_key', 'partner_request_id']),
      inject: {
        context: {
          managed_access_token: target.token,
          managed_advertiser_id: target.advertiserId,
        },
      },
    });
    await operational.updateMediaBuy(ctxFor(target), perTarget);
  }
}
```

The wire-spec field allowlists come from codegen
(`scripts/generate-wire-spec-fields.ts` walks `schemas/cache/{version}/`
and emits the field arrays). Drift between this map and the schemas
is structurally impossible — both are emitted from the same codegen
pass.

`pickWireSpecFields` covers fan-out request types that adopters
realistically forward upstream — every mutating tool in
`MUTATING_TASKS` plus `get_media_buy_delivery` (the canonical poller
read). Read-only catalog tools (`list_*`) aren't fan-out targets and
aren't in the codegen allowlist; if your storefront fans out a
read-only call, the buyer-facing `credentialPolicy` already covers
the input scan.

**Migration footgun: chain `pickWireSpecFields` with `scrubExtensions`.**
`pickWireSpecFields` ALONE doesn't close the round-2 / round-3
vectors (nested `context.<x>_access_token`, nested
`ext.<x>_access_token`). `ext` and `context` are wire-spec fields, so
`pickWireSpecFields` preserves them whole. You MUST chain
`scrubExtensions` after the pick to filter ext/context to a known-
safe key allowlist AND recursively drop credential-shaped keys at
any depth (the helper's `recursiveCredentialScan` option, on by
default, walks `ext`/`context` values and drops nested credential-
shaped keys per the L1 default pattern set).

```ts
// ❌ Round-2 / round-3 reopened: ext and context preserved verbatim
const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
await operational.updateMediaBuy(ctx, safe);  // bug

// ✅ ext/context filtered + recursively scrubbed
const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
const perTarget = scrubExtensions(safe, {
  allowedExtKeys: new Set(['scope3_api_key', 'partner_request_id']),
  // recursiveCredentialScan defaults to true — closes nested vectors
});
await operational.updateMediaBuy(ctx, perTarget);
```

If you migrate from a hand-rolled `scrubRequestForFanout` (e.g. the
`scope3data/agentic-adapters` shim), do the swap atomically — both
helpers in the same diff, same code review, same merge.

### `scanAuthInfo`: extending the perimeter to `ctx.authInfo.extra` (#1539)

`credentialPolicy.policy` enforces the args-bag scan. Custom
authenticators that stamp values into `authInfo.extra` (token-
introspection responses, JWT claim sets, OAuth scope blobs) are
outside that scan — but adopter handler code that reads
`ctx.authInfo.extra.<credential>` for upstream auth produces a silent
leak surface, and a buggy `BuyerAgentRegistry.resolve` factory that
throws an error embedding `extra` lands the value in `logger.error`.

`scanAuthInfo: true` extends the credential-shaped scan to cover
`ctx.authInfo.extra` at any depth using the same pattern set as the
args scan. **Orthogonal to `policy`** — adopters can mix-and-match:

```ts
// Strictest: scan both args and authInfo
credentialPolicy: { policy: 'authInfo-only', scanAuthInfo: true }

// Trust args, defend authInfo log propagation
credentialPolicy: { policy: 'lax', scanAuthInfo: true }

// L1 baseline (default — scanAuthInfo omitted)
credentialPolicy: 'authInfo-only'
```

Default `false` is deliberate. Two false-positive classes warrant
the opt-in rather than opt-out shape:

1. **JWT / OAuth introspection claims** — `id_token`, `access_token`,
   `refresh_token` claims that the framework's authenticator
   legitimately stamps into `extra` will match `/_token$/i`. Default-
   true would reject every adopter running an OAuth-introspection
   authenticator on first deploy.
2. **Adopter-stashed operational metadata with credential-shaped
   names** — fields like `account_secret`, `tenant_password`, or
   `partner_api_key` used as opaque routing/lookup metadata (not
   actual credentials) match the runtime patterns. Two ways to fix
   when you opt in: (a) rename the field to something the matcher
   doesn't catch (`account_external_id`, `tenant_lookup_key`), or
   (b) extend the runtime matcher with `credentialPolicy.patterns.matcher`
   to define a custom predicate that excludes your specific names.
   Renaming is preferred — credential-shaped names in operational
   metadata are themselves a code-review smell.

Adopters opt in only when their authenticator keeps `extra`
credential-clean and their operational-metadata field names don't
overlap the matcher set.

**Wire-envelope discipline.** Args-bag hits report in
`details.credential_paths` (the buyer already knows what they sent).
**`authInfo.extra` hits are LOG-ONLY** — paths surface in
`logger.warn` server-side; the wire envelope reports a coarse signal
(`details.scope: 'credentials'`, `recovery: 'terminal'`) without
enumerating which `extra` field tripped the scan. Disclosing
authInfo paths to buyers would create a probing oracle for an
internal value the buyer has no read access to.

**Log-sink discipline.** If your logger fans out to a buyer-readable
destination (multi-tenant log multiplex, shared OTel collector with
weak tenant routing), the path strings re-enter the disclosure
surface. Keep `logger.warn` output on a tenant-isolated destination
— same rule that applies to every other server-side log line per
the rest of this guide.

**Testing discipline.** The args scan runs first; if your test
fixtures always carry args-bag credentials, you'll never exercise
the authInfo path. Cover both independently — a dev test passing
on the args side is no signal that the authInfo path works.

Per-tool `'lax'` overrides only affect the args scan — `scanAuthInfo`
fires regardless. Adopters who legitimately stamp credential-shaped
values into `authInfo.extra` should fix the authenticator, not
per-tool-disable the scan.

### What `credentialPolicy` does NOT cover

`credentialPolicy` closes the **credential-smuggling** half of the
storefront fan-out attack surface. It does NOT cover **identity
pivoting** — a buyer who sends `request.account: { brand:
'attacker.com' }` to pivot the resolved account onto a different
tenant inside the storefront's session. That category looks like
this:

```jsonc
// NOT caught by credentialPolicy — `account` is a wire-spec field,
// not credential-shaped.
{
  "media_buy_id": "mb_123",
  "account": { "brand": "attacker.com" }
}
```

The mitigation lives in `AccountStore.resolve`: every storefront
should validate that the resolved account is one the authenticated
principal is authorized to access. The framework's
`createDerivedAccountStore` (single-tenant) and `createTenantStore`
(multi-tenant) bake this in; custom resolvers must implement the
org-gating check themselves. See
[`docs/guides/account-resolution.md`](./account-resolution.md).

If your resolver doesn't gate on the principal's authorized accounts,
`credentialPolicy: 'authInfo-only'` will not save you.

---

## Related: handler responses are cached for `ttlSeconds`

`ctx_metadata` isn't the only cache surface that holds adopter values at
rest. The **idempotency cache** stores whatever the handler returned as
the response payload, in the configured backend, for the declared
`ttlSeconds` (default 24h, max 7d per spec). The hash-exclusion list
strips `idempotency_key`, `governance_context`, and
`push_notification_config.authentication.credentials` from the **hash**
so a rotated credential on retry doesn't false-conflict — but the
**stored response** is the handler's verbatim output. If the handler
returns:

- a refreshed bearer / OAuth access token,
- a signed governance / auth payload,
- `push_notification_config.authentication.credentials` (echoed back),
- any other secret material,

those secrets sit at rest in the backend for the replay window. On
Redis without TLS, they're plaintext over the wire too.

**Don't return credentials in handler responses.** The spec doesn't
require it for any AdCP tool; if your adapter is echoing them back,
refactor. If a buyer-supplied credential must be echoed (e.g., to
confirm receipt of `push_notification_config`), wrap your handler to
scrub before returning OR use a custom `IdempotencyBackend` that
transforms entries on the write path. JSDoc on
`IdempotencyStoreConfig` carries the full version of this warning at
the read site.

See also [GitHub #1856](https://github.com/adcontextprotocol/adcp-client/issues/1856) — the SDK does not ship a built-in response scrubber because it would change the wire shape of legitimate adopter responses without warning. The track-record-of-shipped-credentials-in-responses issue is rare enough that opting into a scrubber per-deployment is the right shape.
