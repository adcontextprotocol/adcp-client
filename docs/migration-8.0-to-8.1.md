# Migrating from `@adcp/sdk` 8.0 to 8.1

> **Scope.** This guide is for adopters already on the 8.x beta line,
> moving from the 8.0 beta cut to 8.1. The big theme is AdCP
> 3.1.0-beta.5 catch-up: response envelopes became stricter, several
> domain `status` fields were renamed to stop colliding with task status,
> and webhook verification moved from "example code" to a production recipe.

## TL;DR

- Add envelope `status` everywhere you construct raw wire responses. Server
  framework users get this stamped for them.
- Emit release-precision `adcp_version` values such as `3.1-beta.5`, not
  full semver values such as `3.1.0-beta.5`.
- Rename domain-level status fields that collided with task status:
  `MediaBuy.status` -> `media_buy_status`, creative approval `status` ->
  `approval_status`, rights acquisition `status` -> `rights_status`.
- Drop `governance_agents[].categories`; 8.1 validates those items as closed.
- Use `packageRefsForFormatOptions()` for beta.5 media-buy package requests.
  `packageRefsForCapabilities()` is beta.3-only and now emits a one-time
  warning because beta.5 sellers reject `capability_ids`.
- Treat `PROPOSAL_NOT_FOUND` as correctable. Projection diagnostics now report
  `format_option_id` rather than the beta.3 `capability_id` name.
- Fully migrated off `format_ids[]`? Use `toCanonicalOnlyProduct` /
  `toCanonicalOnlyResponse` to drop them — diagnostics flag any ref that
  didn't project, so dropping legacy never silently loses a format.
- For webhook receivers, move to RFC 9421 verification and a shared replay
  store before running more than one replica. See
  [Verifying inbound webhooks](./recipes/verifying-inbound-webhooks.md).
- Generic response verification remains unsupported in AdCP 3.x. The SDK
  keeps signing-only response helpers for compatibility with adopters that
  publish signed JSON responses.
- If your code extends `ProductSchema`, upgrade to 8.1. `ProductSchema` is
  intentionally a `ZodObject` again, so `.extend()`, `.omit()`, `.pick()`, and
  `.shape` work.
- Replace new seller-side uses of `AuthRequiredError` with
  `AuthMissingError` or `AuthInvalidError`. The SDK still reads legacy
  `AUTH_REQUIRED` responses, and `AuthRequiredError` remains as a deprecated
  `AUTH_REQUIRED` wrapper for source and wire compatibility.
- `comply_test_controller` is now hidden from live principals. Sandbox/mock
  principals still see it; targeting a live or unresolved non-sandbox account
  from that sandbox surface returns `PERMISSION_DENIED`.

## Signing Surface Changes

### RFC 9421 transport response verification remains unsupported

8.1 does not support generic transport response verification because AdCP 3.x
does not authorize RFC 9421 §2.2.9 transport response signing as a protocol
surface. Request signing and webhook signing are unchanged.

The SDK keeps the signing-only compatibility surface for agents that already
sign JSON transport responses and publish `adcp_use: 'response-signing'` JWKs:
`signResponse`, `signResponseAsync`, `buildResponseSignatureBase`,
`ResponseLike`, `ResponseSignatureError`, `RESPONSE_SIGNING_TAG`,
`RESPONSE_MANDATORY_COMPONENTS`, `prepareResponseSignature`,
`finalizeResponseSignature`, `SignResponseOptions`,
`PreparedResponseSignature`, and `SignedResponse`.

Still unsupported:

| Unsupported API | Replacement |
|---|---|
| `verifyResponseSignature`, `createResponseVerifier` | None for generic transport responses |
| `VerifyResponseOptions`, `VerifyResponseResult`, `CreateResponseVerifierOptions` | None |

`pemToAdcpJwk({ adcp_use: 'response-signing' })` and
`mintEphemeralEd25519Key({ adcp_use: 'response-signing' })` are accepted for
this compatibility signing path. `signRequestAsync()` and `signWebhookAsync()`
still fail closed when given response-signing keys. `signResponseAsync()` also
requires providers to declare `adcpUse: 'response-signing'`; legacy providers
that omit `adcpUse` remain accepted by request/webhook helpers but are refused
for response signing.

There is no conformant AdCP 3.x replacement for generic transport response
verification. Future designated-task payload JWS support should be added under a
fresh spec-defined purpose and helper surface rather than expanding this
compatibility signing path.

## Wire Shape Tightening

### Envelope `status` is required

AdCP 3.1.0-beta.2 requires top-level envelope `status` on every response,
including error responses. The SDK server framework now defaults success
responses to `status: 'completed'` and error responses to `status: 'failed'`
unless a tool explicitly returns a richer task state such as `submitted` or
`working`.

Raw-handler adopters should audit for hand-constructed responses:

```bash
rg -n "return \\{|status:" src
```

If the object is a protocol response envelope, it needs a task-status value.
If it is a domain object nested inside a response, use the renamed domain
fields below rather than overloading `status`.

### `adcp_version` uses release precision

Wire `adcp_version` values use `MAJOR.MINOR` precision with an optional
prerelease suffix. Examples:

| Internal bundle/version | Wire value |
|---|---|
| `3.1.0-beta.5` | `3.1-beta.5` |
| `3.1.0` | `3.1` |

The SDK framework normalizes this automatically. Custom emitters should not
copy package or schema-cache semver strings directly into wire envelopes.

### Domain status fields no longer share the task-status key

Top-level `status` is the task envelope. Domain resources use their own names:

| Old 8.0 beta field | 8.1 field |
|---|---|
| `media_buy.status` | `media_buy.media_buy_status` |
| `creative_approvals[].status` | `creative_approvals[].approval_status` |
| `acquire_rights.status` | `acquire_rights.rights_status` |

This removes the ambiguity where `status` could mean either the task lifecycle
(`completed`, `failed`, `submitted`) or a business lifecycle (`active`,
`approved`, `licensed`).

### `governance_agents[].categories` was removed

The 3.1 schema now treats governance-agent entries as closed objects and
removes the legacy `categories` field. If you used that field for operator
metadata, move it to your own registry or extension store; do not emit it in
`sync_governance`, account responses, or test fixtures.

### Mutating request schemas allow extensions

Mutating request validation now follows the AdCP 3.1 rule that vendor
extensions can travel on request shapes. Runtime validation accepts unknown
extension keys on those mutating requests, while SDK-owned fields are still
validated strictly. If you had tests asserting "unknown key rejected" on
mutating requests, update them to assert that known fields still validate and
that extension keys are carried intentionally. Do not use this as a place for
credentials; `ctx_metadata` and extension objects can still land in logs and
error envelopes.

## Type-Level Changes

### Format-option package helpers

AdCP 3.1.0-beta.5 removed the beta.3 `capability_ids` request path from
`PackageRequest`; beta.5 sellers reject that field rather than treating it as
an extension. New buyer code should compose packages with:

```ts
import { packageRefsForFormatOptions } from '@adcp/sdk/v2/projection';
```

`packageRefsForCapabilities()` remains exported for callers pinned to beta.3
fixtures or sellers, but it is marked deprecated and emits a one-time warning
on 8.1 because its return value is intentionally beta.3-only.

Projection diagnostics also use the beta.5 field name:
`diagnostic.error.details.format_option_id`. If you log or branch on the old
beta.3 diagnostic detail `capability_id`, update that reader while keeping any
stored historical logs as-is.

### Proposal-not-found recovery

`PROPOSAL_NOT_FOUND` now reports `recovery: 'correctable'` in proposal refine /
finalize paths. This matches beta.5 storyboards: buyers can correct the
`proposal_id` and retry rather than treating the failure as terminal. The SDK's
retry policy already routes this code through its per-code policy, so callers
using `decideRetry()` do not need a custom override.

### Auth code split

AdCP 3.1 splits the old `AUTH_REQUIRED` code into two explicit cases:

| Code / class | Meaning | Default buyer retry policy |
|---|---|---|
| `AUTH_MISSING` / `AuthMissingError` | No credentials were presented | Escalate as `auth`; retry only if your agent can supply credentials. |
| `AUTH_INVALID` / `AuthInvalidError` | Credentials were presented but rejected or revoked | Escalate as `terminal`; do not retry blindly. |
| `AUTH_REQUIRED` / `AuthRequiredError` | Deprecated 3.0 compatibility code | Still accepted on the wire; the typed class still emits `AUTH_REQUIRED` for compatibility. |

New seller code should throw `AuthMissingError` when no credential arrived and
`AuthInvalidError` when verification rejects a presented credential. Existing
buyer code using `BuyerRetryPolicy` does not need a custom override: the
default table already escalates `AUTH_MISSING` as an auth problem and
`AUTH_INVALID` as terminal to avoid retry storms against revoked credentials.
Buyer code must continue to handle legacy `AUTH_REQUIRED`: older sellers and
some compatibility helper paths still surface it during the 3.x deprecation
window.

## Compliance Controller Visibility

AdCP 3.1 tightens deterministic-test discovery: production callers must be
byte-equivalent to a seller that never wired `comply_test_controller`.

For `createAdcpServerFromPlatform` adopters that supply `complyTest`, the
framework now resolves the auth-derived principal with
`platform.accounts.resolve(undefined, ctx)` before answering
`get_adcp_capabilities`, `tools/list`, or a direct controller call:

| Principal mode | Capability block | `tools/list` | Direct controller call |
|---|---|---|---|
| `sandbox` / `mock` | Includes `compliance_testing` | Includes `comply_test_controller` | Dispatches, then target-account gate applies |
| legacy resolved `{ sandbox: true }` | Includes `compliance_testing` | Includes `comply_test_controller` | Dispatches, then target-account gate applies |
| `live` / unresolved | Omits `compliance_testing` | Filters the tool | MCP method-not-found |

Within the visible sandbox/mock surface, the target account is resolved from
the request parameters. If that target resolves to live or cannot be resolved
as sandbox/mock, the controller returns `PERMISSION_DENIED`; this is the
intentional denial path for "sandbox caller, non-sandbox target." Keep
`capabilities.compliance_testing` declared when using `complyTest`, and make
`accounts.resolve(undefined, ctx)` resolve the authenticated principal if you
want discovery without the legacy env bridge. Legacy `ADCP_SANDBOX=1` still
exposes the controller for old conformance deployments, but it fails closed if
the process has resolved any explicit live-mode account. A buyer-supplied
`account.sandbox: true` is only consulted as an unresolved target-account
fallback after the principal visibility check has already passed; it never makes
a live principal visible and never overrides a resolved live target account.

### `ProductSchema` is a `ZodObject` again

8.0's generated `ProductSchema` could appear as a marker-only intersection,
which made object helpers disappear even though validation behavior was still
object-shaped. 8.1 collapses those marker-only intersections during codegen.

This is intentional: the schema keeps the same runtime validation semantics,
but TypeScript users can again write:

```ts
import { ProductSchema } from '@adcp/sdk';
import { z } from 'zod';

const ProductWithLocalField = ProductSchema.extend({
  local_score: z.number(),
});
```

Use this for local validation/adaptation. Do not infer that extension fields
belong on the AdCP wire unless the relevant request schema permits extensions.

### `SyncAccountsRequest.accounts[]` branches are typed

The generated TypeScript now narrows the mutually exclusive
`SyncAccountsRequest.accounts[]` branches correctly. `ProvisioningMode` and
`SettingsUpdateMode` expose their real fields instead of a loose passthrough
shape, including `notification_configs[]` for account-scoped events. Existing
valid payloads keep working; the adopter-visible change is better
autocomplete/type-checking and fewer accidental unknown-field escapes.

### `get_products` response shape

`products` can be absent in valid response arms such as unchanged/cache-hit
responses. Any response that carries `products` or `unchanged: true` must now
also carry `cache_scope`. Test fixtures that assumed `products` was always
present or omitted `cache_scope` on populated or unchanged responses need to be
updated.

Use this decision table for server payloads:

| Request / pricing shape | `cache_scope` |
|---|---|
| No inline `account` and no auth-derived/resolved account context | `public` |
| Request has `account`, but response uses the universal rate card | `public` |
| Request has `account` and response includes account-specific pricing or overlays | `account` |

The SDK framework may fill `public` only when there is no inline `account`
and no auth-derived/resolved account context. It does **not** infer `public`
for account-scoped requests because agents may omit overlay capability
declarations for confidentiality; account-scoped product responses should set
`cache_scope` explicitly.

Client/storefront composition code that consumes upstream inventory sources can
normalize older upstream responses before caching:

```ts
import { ensureGetProductsCacheScope } from '@adcp/sdk';

const upstream = await seller.getProducts(req);
const response = ensureGetProductsCacheScope(upstream, {
  defaultCacheScope: 'account', // fail-closed for composed storefronts
  onInject: event => logger.warn('Injected get_products cache_scope', event),
});
```

`validateGetProductsCacheScope(response)` is the non-mutating check. It returns
`{ ok: false, reason: 'missing_cache_scope' | 'invalid_cache_scope' }` when a
populated or unchanged response is not cache-safe.

## Canonical Creative Format Migration

8.1 makes the canonical-format migration path easier to find from the package
root and from `@adcp/sdk/v2/projection`.

The package root exposes the `CanonicalFormat.*` namespace and migration
types. Individual builder functions such as `imageFormatDeclaration()` remain
available from `@adcp/sdk/v2/projection` for callers who prefer named imports.

Use `format_options[]` as the canonical product surface. Keep `format_ids[]`
only as the v1 fallback during the migration window, using the v2 declaration's
`v1_format_ref[]` as the authoritative pairing:

```ts
import {
  CanonicalFormat,
  packageRefsForCapabilities,
  withFormatOptions,
} from '@adcp/sdk';

const homepageMrec = CanonicalFormat.image(
  { width: 300, height: 250 },
  {
    capability_id: 'homepage_mrec',
    display_name: 'Homepage MREC',
    v1_format_ref: [
      CanonicalFormat.ref('https://creative.adcontextprotocol.org', 'display_300x250_image'),
    ],
  }
);

const product = {
  product_id: 'homepage_takeover',
  name: 'Homepage Takeover',
  format_options: [homepageMrec],
  format_ids: homepageMrec.v1_format_ref,
  product_card: CanonicalFormat.productCard({
    title: 'Homepage Takeover',
    price_label: 'From $12 CPM',
  }),
};
```

Do not put `format_id` on `product_card`. Product cards describe the product UI;
creative acceptance lives in `format_options[]` and the v1 fallback
`format_ids[]`.

### Reading canonical-only (dropping the legacy `format_ids[]`)

`withFormatOptions` / `augmentProductWithFormatOptions` are **additive** — they
add `format_options[]` but preserve `format_ids[]` for back-compat. Once a
consumer has fully migrated, that preserved `format_ids[]` is a foot-gun: naive
downstream code keeps reading the stale `{ agent_url, id }` shape and silently
bypasses the canonical model. `toCanonicalOnlyProduct` / `toCanonicalOnlyResponse`
are the canonical-only counterparts — `format_options[]` only, `format_ids[]`
dropped:

```ts
import { toCanonicalOnlyResponse } from '@adcp/sdk';

const { response, diagnostics } = toCanonicalOnlyResponse(getProductsResponse);
// response.products[i] has format_options[] and NO format_ids[]
if (diagnostics.length > 0) logger.warn('Dropped legacy refs that did not project', diagnostics);
```

Dropping legacy never silently loses a format. Every input `format_id` is either
represented in `format_options[]` or surfaced in `diagnostics` —
`FORMAT_PROJECTION_FAILED` on the v1→v2 projection path, or
`LEGACY_FORMAT_ID_DROPPED_UNMAPPED` when a v2-native product carries a
`format_ids[]` entry no `format_options[].v1_format_ref` covers. Keep
`withFormatOptions` while you still read `format_ids[]`; switch to
`toCanonicalOnly*` when you no longer do.

Buyer/write-side migration:

```ts
const { response, diagnostics } = withFormatOptions(getProductsResponse);
if (diagnostics.length > 0) logger.warn('Format projection diagnostics', diagnostics);

const product = response.products[0];
const refs = packageRefsForCapabilities(product, ['homepage_mrec']);

await agent.createMediaBuy({
  packages: [{
    product_id: product.product_id,
    pricing_option_id: product.pricing_options[0].pricing_option_id,
    ...refs, // capability_ids + format_ids when a v1 fallback exists
    budget: 5000,
  }],
});
```

### Resolving a bare format-id persisted before the `{ agent_url, id }` convention

If you stored bare format-id strings (`display_300x250_image`,
`video_standard_30s`) before the structured-ref convention and maintain a local
`inferFormatKindFromFormatId` heuristic, delete it. `resolveCanonicalFormatKind`
and `canonicalDeclarationFromBareId` resolve a bare id against the same catalog +
registry the projection uses — one source of truth instead of a heuristic that
drifts from the canonical registry:

```ts
import { resolveCanonicalFormatKind, canonicalDeclarationFromBareId } from '@adcp/sdk';

resolveCanonicalFormatKind('display_300x250_image'); // 'image'
resolveCanonicalFormatKind('video_standard_30s'); // 'video_hosted'

// Lift a bare id to a full v2 declaration carrying v1_format_ref in one step:
const decl = canonicalDeclarationFromBareId('display_300x250_image');
// decl.format_kind === 'image'
// decl.v1_format_ref === [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }]
```

Both fail closed — they return `null`, never a guess, for an unknown id, an
under-specified id (`display_300x250`, which the catalog only carries as
`_image` / `_html` / `_generative` variants), or an id from a non-AAO catalog.

If you hold the asset type (e.g. a `format_type` field), pass `assetTypeHint`
to disambiguate an under-specified id — the resolver retries the catalog
variant `<id>_<suffix>` instead of you re-deriving the suffix:

```ts
resolveCanonicalFormatKind('display_300x250', { assetTypeHint: 'image' }); // 'image'
resolveCanonicalFormatKind('display_300x250', { assetTypeHint: 'html' }); // 'html5'
// canonical-kind aliases work too: 'html5' → '_html', 'display_tag' → '_js'.
// Still fails closed if <id>_<suffix> isn't a catalog entry.
```

Pass `{ agentUrl }` when the bare id was minted under a different agent's
catalog. For the structured diagnostic explaining _why_ an id didn't resolve,
run it through `projectV1ProductToV2` inside a one-format product.

`ListCreativeFormatsPayload` is the canonical alias for the server handler
payload shape of `list_creative_formats`. `ListCreativeFormatsResponsePayload`
and `ListCreativeFormatsServerPayload` remain equivalent aliases for search
and older local naming conventions. Prefer the canonical alias in new
platform/server code instead of annotating handlers with the generated wire
response type.

## Handler Payloads vs Wire Envelopes

Framework server adopters should return SDK server payload aliases from
handlers. Do not hand-stamp protocol envelope fields such as `status`,
`task_id`, or `adcp_version` when using `createAdcpServerFromPlatform`; the
framework owns those fields and validates after wrapping.

Raw/manual server adopters using response builders still need to pass
schema-valid payloads into the builder. For example:

```ts
productsResponse({ products, cache_scope: 'public' });
mediaBuyResponse({ media_buy_id, media_buy_status: 'pending_creatives', packages: [] });
```

`SyncCreativesPayload` now covers both sync success rows and operation-level
failure payloads:

```ts
const failed: SyncCreativesPayload = {
  errors: [{ code: 'INVALID_REQUEST', message: 'invalid creative batch' }],
};
```

Raw/manual server adopters can pass either arm to `syncCreativesResponse()`;
operation-level errors produce an MCP error response with envelope
`status: 'failed'`.

Buyer, CLI, and testing users should use `@adcp/sdk@beta` or an exact
`8.1.0-beta.N` pin while validating AdCP 3.1 behavior. `@latest` remains on
the last GA line until 8.1 exits prerelease.

## The Two `TaskStatus` Types

There are two similarly named concepts:

| Import/source | Use it for |
|---|---|
| `TaskResult['status']` from the root client API | Handling SDK call results, including client result states like `deferred` and `governance-denied`. |
| `TaskStatus` from `@adcp/sdk`'s conversation/client types | Legacy client-side status vocabulary used inside the SDK, including compatibility states such as `pending`, `running`, `needs_input`, and `aborted`. |
| Protocol `TaskStatus` from generated protocol types / server payload helpers | Wire envelope `status` values on AdCP responses and webhook payloads. |

Do not use the root client `TaskStatus` alias as the schema for wire
responses. It intentionally includes client-side compatibility states. For
server handler domain payloads, prefer the SDK's server payload aliases so
envelope fields owned by the framework are stripped from handler return types.

## Webhook Verification

8.1 keeps the legacy HMAC helper for older `push_notification_config` buyers,
but the spec-current path is RFC 9421 webhook signing with
`adcp_use: "webhook-signing"` keys. The short version:

- Capture raw request bytes before JSON parsing.
- Resolve the expected sending agent from your operation state or route, not
  from attacker-controlled signature headers.
- Verify with `createWebhookVerifier` / `verifyWebhookSignature`.
- Use a shared `ReplayStore` for multi-replica receivers.
- Keep HMAC as an explicit legacy branch only; do not fail open from one scheme
  to another.

Full recipe: [Verifying inbound webhooks](./recipes/verifying-inbound-webhooks.md).

## Checklist

- [ ] Raw response fixtures include envelope `status`.
- [ ] Raw error fixtures include `status: 'failed'`.
- [ ] Wire `adcp_version` is release-precision.
- [ ] Business lifecycle fields use `media_buy_status`, `approval_status`, and
  `rights_status`.
- [ ] `governance_agents[]` fixtures no longer emit `categories`.
- [ ] `get_products` fixtures with products include `cache_scope`.
- [ ] Storefront/upstream adapters normalize legacy get_products responses with
  `ensureGetProductsCacheScope()` before caching.
- [ ] Products that support canonical creative formats publish `format_options[]`
  and keep `format_ids[]` only as the v1 fallback.
- [ ] Fully-migrated readers use `toCanonicalOnlyProduct` / `toCanonicalOnlyResponse`
  instead of `withFormatOptions`, and surface the diagnostics those return.
- [ ] Webhook receivers capture raw body bytes and verify before processing.
- [ ] Multi-replica webhook receivers use Redis/Postgres replay storage.
