# Migrating from 12.x to 13.x

Version 13 makes canonical creatives the contract of the primary TypeScript SDK. Installing the modern SDK means application code uses `format_kind`, `format_options`, and `format_option_refs`; `{ agent_url, id }` creative format identity is confined to wire adapters and explicitly named migration APIs.

## Compliance results serialize scenario detail once

`ComplianceResult.tested_tracks` is now `TestedTrackEntry[]` rather than
`TrackResult[]`. These filtered reference entries retain track identity, status,
label, observations, duration, mode, and `_view: 'reference'`, but omit
`scenarios` and `skipped_scenarios`. The canonical scenario arrays live under
`ComplianceResult.tracks`, preventing `--json` reports from serializing every
scenario twice.

Consumers that previously read `result.tested_tracks[n].scenarios` should
iterate `result.tracks` instead:

```ts
for (const track of result.tracks) {
  for (const scenario of track.scenarios) {
    consumeScenario(scenario);
  }
}
```

CI consumers that need a stable, compact artifact should continue using
`buildComplianceSummary()` from `@adcp/sdk/testing` (also re-exported by
`@adcp/sdk/compliance`) or `--summary-output`.
`TestedTrackEntry` is exported from `@adcp/sdk/testing` and
`@adcp/sdk/compliance` for status-only consumers. Custom fixtures that formerly
used `_view: 'reference'` on a `TrackResult` should use `TestedTrackEntry` instead;
`TrackResult._view` now accepts only `'canonical'`.

## Synchronous completion webhooks

`createAdcpServerFromPlatform()` no longer emits a completion webhook by
default when a request returns a terminal result inline. AdCP completion
webhooks describe status changes after the initial response; buyers already
have a synchronous result and should consume it directly.

Existing integrations that temporarily depend on duplicate inline + webhook
delivery can pass `autoEmitCompletionWebhooks: true`. This is a non-conformant
compatibility extension covering synchronous discovery (`get_products`,
`get_signals`) and mutation responses. Its synthesized `sync-*` task ID is not
registered and cannot be polled with `get_task_status`. Delivery is detached
and best-effort, so use durable request idempotency, ingress rate limits, and
bounded emitter timeouts while migrating. Remove the option once buyers handle
the inline terminal response.

## Root type imports are canonical

The unqualified root exports `Product`, `Format`, `CreativeAsset`, `Package`, `PackageRequest`, `PackageUpdate`, `Placement`, `CreateMediaBuyRequest`, `UpdateMediaBuyRequest`, `SyncCreativesRequest`, and their creative-bearing response and server-payload types now mean their canonical shapes. Legacy wire shapes have `Legacy*` names. The old format-reference types are available only as `LegacyFormatID` / `LegacyFormatReferenceStructuredObject` from the root; the explicit `@adcp/sdk/types` protocol subpath remains raw for wire tooling.

```ts
import type {
  Product,                    // canonical
  SyncCreativesRequest,       // canonical
  LegacyProduct,              // raw legacy wire shape
  LegacySyncCreativesRequest, // raw legacy wire shape
} from '@adcp/sdk';
```

Do not fix an upgrade error by adding `format_id` or `agent_url` to a canonical object. Select a `format_option_id`, send `format_option_refs`, and give each creative a canonical `format_kind`.

Conformance code that merges sparse product fixtures onto raw legacy defaults
can use the explicitly named testing helper without a cast:

```ts
import type { LegacyProduct } from '@adcp/sdk';
import { mergeSeedProductLegacy } from '@adcp/sdk/testing';

const merged: Partial<LegacyProduct> = mergeSeedProductLegacy(defaults, fixture);
```

`mergeSeedProductLegacy` has the same runtime behavior as
`mergeSeedProduct` and preserves the subtype of the baseline object.

## Client methods

The primary `getProducts`, `createMediaBuy`, `updateMediaBuy`, `syncCreatives`, `listCreatives`, `getMediaBuys`, `getMediaBuyDelivery`, and `getCreativeDelivery` methods accept and return canonical creative shapes. Their generic `executeTask()` equivalents enforce the same boundary.

`getProducts()` no longer accepts `fields: ['format_ids']`; request `format_options` instead. `listCreatives()` similarly excludes the legacy `format_id` response field and `filters.format_ids`.

Raw compatibility calls are deliberately conspicuous: use `getProductsLegacy()`, `createMediaBuyLegacy()`, `updateMediaBuyLegacy()`, `syncCreativesLegacy()`, `listCreativesLegacy()`, or `executeTaskLegacy()` only in migration and conformance code. Legacy format discovery, building, previewing, and transformer discovery likewise use their `*Legacy` methods.

### Registry brand relationships

`RegistryClient.resolveBrandHierarchy()` and `resolveBrandHierarchies()` have been removed. They targeted `/api/brands/hierarchy` routes that the public v3 registry deliberately retired, and converted the resulting 404 into `null`, making a missing route indistinguishable from a missing relationship.

Use `lookupBrand()` or `lookupBrands()` and inspect the resolved relationship instead. Call `lookupBrand(domain, { fresh: true })` when a policy requires a live origin check:

```ts
const brand = await registry.lookupBrand('leaf.example', { fresh: true });
if (!brand) {
  // The declared /api/brands/resolve endpoint found no resolvable brand.
  return;
}

if (brand.live_brand_json) {
  // The live check failed and this response contains stored evidence.
  return;
}

if (
  brand.house_domain &&
  (brand.relationship_trust === 'mutual' || brand.relationship_trust === 'inline')
) {
  authorizeHouseRelationship(brand.house_domain);
}
```

Only `mutual` and `inline` are reciprocated. `claimed_house_domain` is one side's self-assertion and is not authorization evidence. For `mutual`, use `relationship_verified_at` and `relationship_declared_at` to apply any stricter freshness policy. V3 hierarchy is one level deep; there is no replacement ordered-chain call. The removed methods' client-side `ttlMs` cache is also gone. `lookupBrands()` performs ordinary bulk lookups but has no fresh mode; callers that need multiple live reads should fan out bounded `lookupBrand(domain, { fresh: true })` calls and own any caching while respecting registry rate limits.

`source` is provenance, not relationship evidence. Missing `relationship_trust` means unknown. Pass `{ fresh: true }` when the caller requires a live origin check; `live_brand_json` means that check failed and the resolver returned stored evidence. Inspect `migration_warnings` when `promoted_from_schema` is present, but do not treat an absent warning as proof that every legacy relationship field was promoted.

Standard tasks that indirectly carry legacy identity through artifacts, manifests, standards, or rights constraints no longer appear in the primary typed task map. This includes:

- `list_content_standards`, `get_content_standards`, `create_content_standards`, and `update_content_standards`
- `calibrate_content` and `validate_content_delivery`
- `get_media_buy_artifacts` and `get_creative_features`
- `get_rights`, `acquire_rights`, and `update_rights`

The existing direct content-standard methods are now `listContentStandardsLegacy()`, `getContentStandardsLegacy()`, `calibrateContentLegacy()`, and `validateContentDeliveryLegacy()`. Use `executeTaskLegacy()` for the remainder. `executeCustomTask()` rejects these names because a standard AdCP tool is not a vendor extension.

## Server platform methods

The decisioning framework continues to register the legacy protocol tool names through AdCP 3.x, but raw-format adopter hooks are now explicit. Rename platform implementations as follows:

- Creative builder and ad-server hooks: `buildCreativeLegacy`, `previewCreativeLegacy`, `listCreativeFormatsLegacy`, and `refineCreativeLegacy`
- Sales format discovery: `listCreativeFormatsLegacy`
- Content standards: append `Legacy` to every content-standard, artifact, and creative-feature method
- Brand rights: `getRightsLegacy`, `acquireRightsLegacy`, and `updateRightsLegacy`

Their raw payload and return aliases also use `Legacy*` names. The framework still maps these methods to `build_creative`, `preview_creative`, `list_creative_formats`, the content-standard tools, and the rights tools on the wire. This naming boundary prevents raw `{ agent_url, id }` shapes from looking canonical in adopter code while preserving protocol compatibility until AdCP 4.0.

Raw handler groups used while incrementally migrating from `createAdcpServer()` now live under an explicit option:

```ts
createAdcpServerFromPlatform(platform, {
  name: 'seller',
  version: '13.0.0',
  legacyHandlers: {
    mediaBuy: { listCreativeFormats: legacyListFormatsHandler },
  },
});
```

The same rule applies to raw `creative`, `governance`, and `brandRights` groups. Pre-13 untyped JavaScript objects still work at runtime for transition safety, but TypeScript exposes only `legacyHandlers`.

## Legacy utility and low-level server names

### Upstream recorder payload digests

`computePayloadDigestSha256()` now has one third-argument shape:
`PayloadDigestOptions`. Replace the removed bare `RegExp` and `false` forms
with their named equivalents:

```ts
computePayloadDigestSha256(payload, contentType, {
  redactPattern: /^(authorization|vendor_secret)$/i,
});

computePayloadDigestSha256(redactedPayload, contentType, {
  prenormalized: true,
});
```

TypeScript rejects the old forms, and untyped JavaScript calls fail with
`PayloadDigestError`. When using `redactPattern: false`, also set
`prenormalized: true`; disabling redaction for an unverified payload remains
an error.

Named-format fixtures and preview helpers are no longer easy to mistake for
canonical discovery APIs:

- `STANDARD_FORMATS` → `LEGACY_STANDARD_FORMATS`
- `getStandardFormats()` → `getStandardFormatsLegacy()`
- `batchPreviewFormats()` → `batchPreviewFormatsLegacy()`

Canonical applications discover `format_options[]` with `getProducts()` and
render the self-contained `product_card` when present. The named-format batch
preview helper remains available only for migration tooling that still calls
the legacy `preview_creative` protocol.

Asset-slot inspection is still a primary, canonical utility. Helpers such as
`getFormatAssets()`, `getRequiredAssets()`, `getOptionalAssets()`,
`getIndividualAssets()`, and `getRepeatableGroups()` now accept the minimal
`FormatAssetsInput` shape (`{ assets?: CanonicalFormatAssetSlot[] }`) rather
than the raw generated `Format`. They neither require nor expose `format_id` or
`agent_url`; pass any canonical declaration or local object with an `assets`
array.

Server scaffolding helpers follow the same rule. `buildProduct()` now accepts
canonical declarations and returns a canonical product:

```ts
const product = buildProduct({
  id: 'sports-display',
  name: 'Sports display',
  format_options: [
    {
      format_option_id: 'medium-rectangle',
      format_kind: 'image',
      params: { width: 300, height: 250 },
    },
  ],
  delivery_type: 'non_guaranteed',
  publisher_domain: 'sports.example',
});
```

Code that intentionally assembles the old named-format product moves to the
explicit compatibility helper without changing its input shape:

```ts
const legacyProduct = buildProductLegacy({
  id: 'sports-display',
  name: 'Sports display',
  formats: ['display_300x250'],
  agentUrl: 'https://seller.example/mcp',
  delivery_type: 'non_guaranteed',
  publisher_domain: 'sports.example',
});
```

Likewise, `buildListCreativesResponse()` accepts canonical list requests and
canonical creative rows. Migration tooling that still handles
`filters.format_ids` or rows with `format_id` uses
`buildListCreativesResponseLegacy()`. Asset accessors (`getAsset()`,
`getAssetSlot()`, `requireAsset()`) accept only the identity-free
`CreativeAssetsContainer` view, so a primary helper call cannot depend on a
manifest's legacy format identity.

The old content-standards adapter also carries raw artifact and format
identity. Its public names now make that boundary explicit:
`LegacyContentStandardsAdapter`, `LegacyIContentStandardsAdapter`,
`LegacyContentEvaluationResult`, `LegacyContentStandardsErrorCodes`,
`isLegacyContentStandardsError`, and
`legacyDefaultContentStandardsAdapter`.

Low-level response builders exported by the root and server barrels now use a
`legacy` prefix, for example `legacyProductsResponse`,
`legacyMediaBuyResponse`, and `legacyListCreativesResponse`. Modern
`createAdcpServerFromPlatform()` adopters return canonical payloads directly
and do not wrap them. A v5 handler-bag server can either import the explicit
`legacy*` aliases from `@adcp/sdk/server` or retain the historical unprefixed
names from `@adcp/sdk/server/legacy/v5`.

Likewise, handler-bag types on the primary barrels are now
`LegacyAdcpServerConfig`, `LegacyHandlerContext`,
`LegacyMediaBuyHandlers`, `LegacyCreativeHandlers`, and corresponding
`Legacy*Handlers` aliases. The historical type names remain available from
`@adcp/sdk/server/legacy/v5`.

## Custom legacy formats

The projector accepts pre-resolved `projectionCatalogs` for publisher-hosted
and AAO community catalogs. Supply them in most-specific-first order; exact
catalog-authored `v1_format_ref` aliases run before the bundled AAO catalog.
Projection stays synchronous and deterministic—catalog fetching, SSRF policy,
ETag/TTL caching, and mirror selection happen outside the pure projector.
Injected catalog matching always includes the normalized owner URL, ID, and
dimensional discriminators. A matching `format_option_id` alone is never
enough, and a `canonical_formats_only` declaration never becomes a legacy
alias. The bundled AAO standard-ID compatibility rule below is narrower and
separate.

The bundled catalog upgrades known legacy refs automatically, including the historical AAO `https://adcontextprotocol.org/` owner used by early Optimera deployments. Some deployed sellers copied exact AAO standard IDs while emitting their own creative-agent URL. On inbound legacy discovery, the SDK also accepts an exact bare ID when the bundled AAO catalog publishes that ID with one unique meaning; conflicting inline dimensions or duration still fail, duplicate catalog IDs are never guessed, and the generated `format_option_id` is derived from the legacy tuple rather than its array position. The private same-client route retains the seller's original owner for reverse delivery. Projection is semantic normalization only: it neither fetches nor authorizes the source URL, and later network contact remains subject to the SDK's normal HTTPS and SSRF policy. Seller-specific IDs still require `legacyFormatConverter` (or server-side `legacyCreativeFormatConverter`). Use `format_kind: 'custom'` for a bespoke shape:

```ts
const legacyFormatConverter = ({ formatId }) => ({
  format_kind: 'custom' as const,
  format_option_id: `seller-${formatId.id}`,
  format_shape: 'homepage_takeover',
  format_schema: {
    uri: `https://seller.example/formats/${formatId.id}.json`,
    digest: 'sha256:<64 lowercase hex characters>',
  },
  params: {},
});
```

Configure this once as `legacyFormatConverter` on the client to cover canonical discovery and write paths, async continuations, and webhooks. A per-call converter overrides the configured default; `syncCreatives()` gives its projection-specific converter highest precedence. The explicit `createMediaBuyLegacy()`, `updateMediaBuyLegacy()`, and `syncCreativesLegacy()` methods are raw migration escapes: they preserve legacy wire payloads without creative capability probing or projection, so converter and resolver options are ignored. An invalid conversion is rejected before adopter code receives a partially converted object. On discovery, partially mappable products remain with their mapped canonical options and sanitized `FORMAT_PROJECTION_FAILED` entries in `data.errors`. A product with no canonical option is omitted from the canonical product list because the protocol requires `format_options` to contain at least one declaration; its sanitized non-fatal error remains in `data.errors`. A valid legacy `format_ids: []` product uses `CANONICAL_PRODUCT_FORMATS_UNAVAILABLE` with `reason: 'legacy_format_list_empty'`, not `FORMAT_PROJECTION_FAILED`. `data.projection.diagnostics` mirrors SDK-local detail for convenience, but `errors[]` is the portable, multi-hop surface. Use `getProductsLegacy()` when migration tooling needs the original refs or the complete legacy product list. For ordinary downgrade, use `packageRefsForFormatOptions()` on a product with mapped format options. During one client lifetime the SDK retains the corresponding legacy ref in bounded private metadata. For a process boundary, persist the projector's `legacyRoutes` sidecar and rebuild the resolver with `canonicalFormatLegacyResolverFromRoutes()`, configure `projectionAdaptersFromCatalogSnapshots`, or supply a custom `canonicalFormatLegacyResolver`; canonical data deliberately cannot reconstruct an arbitrary seller owner by itself.

The route sidecar is JSON-safe and includes the full owner, width, height, and
duration tuple. It does not add legacy identity to canonical protocol objects:

```ts
import {
  canonicalFormatLegacyResolverFromRoutes,
  projectV1ProductToV2,
} from '@adcp/sdk/v2/projection';

const { v2: product, legacyRoutes } = projectV1ProductToV2(legacyProduct, {
  legacyFormatConverter,
});

await products.put(product.product_id, product);
await creativeRoutes.put(product.product_id, legacyRoutes);

const restoredRoutes = await creativeRoutes.get(product.product_id);
const canonicalFormatLegacyResolver =
  canonicalFormatLegacyResolverFromRoutes(restoredRoutes);
```

Each `CanonicalFormatLegacyRoute` contains `product_id`, the stable
`format_option_ref`, and one or more exact `format_ids`. Pass the rebuilt
resolver to `AgentClient` or `createAdcpServerFromPlatform()` without changing
the existing resolver callback contract.

For a fixed set of temporary seller adapters, prefer one declarative catalog over
separate forward and reverse callbacks. `projectionAdaptersFromCatalogSnapshots`
turns exact catalog-authored `v1_format_ref` pairs into client configuration for
both discovery upgrade and persisted canonical-to-legacy delivery downgrade:

```ts
import { packageRefsForFormatOptions, projectionAdaptersFromCatalogSnapshots } from '@adcp/sdk';

const voxAdapters = projectionAdaptersFromCatalogSnapshots([
  {
    source: 'configured',
    publisher_domain: 'vox.example',
    formats: [
      {
        format_kind: 'display_tag',
        format_option_id: 'vox_mrec_html',
        params: { width: 300, height: 250 },
        v1_format_ref: [
          {
            agent_url: 'https://formats.vox.example/mcp',
            id: 'vox_mrec_html',
            width: 300,
            height: 250,
          },
        ],
      },
    ],
  },
]);

const client = new AgentClient(agent, voxAdapters);

const selected = packageRefsForFormatOptions(product, [
  { publisher_domain: 'vox.example', format_option_id: 'vox_mrec_html' },
]);
```

The generated reverse resolver uses stable `format_option_id` references and
works after JSON or process boundaries. It never makes a `canonical_formats_only`
declaration legacy-compatible, never returns a partial multi-option mapping, and
fails closed on duplicate aliases at the same precedence tier. The convenience
helper intentionally accepts only publisher-scoped, one-canonical-option-to-one-
legacy-ref routes. A multi-size option must be split into stable option IDs, or
handled by a custom durable resolver that can narrow from canonical params. This
is the recommended shape for short-lived owner-specific adapters while a seller
moves to canonical declarations; remove the catalog entry when the seller
migration is complete.

During one client lifetime, a bounded private route cache preserves exact product-option downgrade routing even when the canonical product is serialized and parsed again. Account-scoped create/update/get-media-buy results also bind returned package IDs to exact routes across synchronous, polling, deferred, and webhook completion. Multiple packages assigned to one creative must resolve to the same legacy ref set. A process restart cannot reconstruct an arbitrary legacy owner from canonical kind/params. Re-run product and media-buy reads that carry enough selector context or configure the separate canonical-to-legacy resolver. An accountless update/sync never consumes a tenant-scoped cached route based only on package ID; include account scope or configure the resolver. This is intentionally not the same function as the inbound converter:

```ts
const canonicalFormatLegacyResolver = context => {
  if (context.source === 'creative' && context.creative.format_kind === 'custom') {
    return {
      agent_url: 'https://seller.example/custom-formats',
      id: 'homepage_takeover',
    };
  }
  if (context.source === 'selector' && context.selector.format_kind === 'custom') {
    return {
      agent_url: 'https://seller.example/custom-formats',
      id: 'homepage_takeover',
    };
  }
  return undefined;
};

const client = new AgentClient(agent, { canonicalFormatLegacyResolver });
```

Server platforms use the same resolver as `createAdcpServerFromPlatform(platform, { canonicalFormatLegacyResolver })`. Resolver output is validated and cannot override `canonical_formats_only: true`; invalid, ambiguous, or missing output fails cleanly instead of emitting a partial legacy object.

## Protocol-version behavior

- AdCP 3.0 is a legacy creative wire. The SDK upgrades inbound data and downgrades canonical requests when an unambiguous mapping exists.
- AdCP 3.1 is the dual-emission transition release. On an otherwise ambiguous `get_products` request, the decisioning server preserves both `format_ids` and `format_options` when an exact legacy route is available; it does not invent a legacy identity for a canonical-only declaration. Explicit canonical or legacy request evidence still narrows the response. For peer negotiation, 3.1 alone is not proof of canonical write support: the SDK uses `media_buy.features.canonical_creatives`, then per-tool schema evidence, and fails closed when no safe mapping exists.
- AdCP 3.2 and later are canonical by contract. Advertising `canonical_creatives: false` at 3.2 is a capability error.

Negotiation uses the mutually supported wire release, so a 3.2 SDK talking to a 3.1-only seller follows the 3.1 rules. See [Canonical creative delivery](guides/CREATIVE-DELIVERY.md) for conversion diagnostics and server integration.
