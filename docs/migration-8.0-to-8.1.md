# Migrating from `@adcp/sdk` 8.0 to 8.1

> **Scope.** This guide is for adopters already on the 8.x beta line,
> moving from the 8.0 beta cut to 8.1. The big theme is AdCP
> 3.1.0-beta.3 catch-up: response envelopes became stricter, several
> domain `status` fields were renamed to stop colliding with task status,
> and webhook verification moved from "example code" to a production recipe.

## TL;DR

- Add envelope `status` everywhere you construct raw wire responses. Server
  framework users get this stamped for them.
- Emit release-precision `adcp_version` values such as `3.1-beta.3`, not
  full semver values such as `3.1.0-beta.3`.
- Rename domain-level status fields that collided with task status:
  `MediaBuy.status` -> `media_buy_status`, creative approval `status` ->
  `approval_status`, rights acquisition `status` -> `rights_status`.
- Drop `governance_agents[].categories`; 8.1 validates those items as closed.
- For webhook receivers, move to RFC 9421 verification and a shared replay
  store before running more than one replica. See
  [Verifying inbound webhooks](./recipes/verifying-inbound-webhooks.md).
- If your code extends `ProductSchema`, upgrade to 8.1. `ProductSchema` is
  intentionally a `ZodObject` again, so `.extend()`, `.omit()`, `.pick()`, and
  `.shape` work.

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
| `3.1.0-beta.3` | `3.1-beta.3` |
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
- [ ] Webhook receivers capture raw body bytes and verify before processing.
- [ ] Multi-replica webhook receivers use Redis/Postgres replay storage.
