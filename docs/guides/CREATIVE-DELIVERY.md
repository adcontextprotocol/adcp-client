# Creative Delivery Helpers

Buyer integrations should treat creative-library sync and inline media-buy
creatives as different workflows.

Canonical creative identity stays canonical in buyer code. At the outbound
boundary, the SDK projects a creative onto the seller-owned legacy `format_id`
only when capability negotiation says the seller is legacy (or support is
unknown and the selected package supplies an unambiguous legacy ref). This
applies automatically to inline
`packages[].creatives` in `AgentClient.createMediaBuy()` and
`AgentClient.updateMediaBuy()`. `inlineCreativesForPackages()` keeps its output
canonical; the client owns the final wire projection.
The caller's creative object is never mutated.

The primary helper accepts only canonical `format_kind` /
`format_option_refs` selectors and canonical creative assets. Legacy
`format_ids`, legacy creative `format_id`, and wire-mode overrides fail
cleanly. Existing protocol tooling that must construct a legacy payload can
use the deprecated, explicitly named `inlineCreativesForPackagesLegacy()`
escape hatch.

`AgentClient.getProducts()` is also canonical-only by default: every product
has `format_options[]`, and legacy `format_ids[]` are removed. Raw wire access
is intentionally explicit via `getProductsLegacy()` for protocol tooling and
migration diagnostics. `v1_format_ref` and nested placement `format_ids` are
also concealed from the primary return value.

`listCreatives()` follows the same boundary on both sides: its request type
does not permit `filters.format_ids` or the legacy `format_id` response-field
selector, and its response contains canonical creative identity. Use
`listCreativesLegacy()` only in migration or protocol tooling that must inspect
the raw named-format wire shape.

Use `supportsSyncCreatives(caps)` to decide whether the seller advertises a
reusable creative library:

```ts
import { inlineCreativesForPackages, supportsSyncCreatives } from '@adcp/sdk';

const caps = await agent.getCapabilities();

if (supportsSyncCreatives(caps)) {
  await agent.syncCreatives({
    account,
    idempotency_key: crypto.randomUUID(),
    creatives,
    assignments,
  });
} else if (caps.features.inlineCreativeManagement) {
  const packagesWithRefs = packages.map((pkg, index) => ({
    ...pkg,
    context: { ...pkg.context, buyer_ref: pkg.context?.buyer_ref ?? `pkg_${index}` },
  }));

  await agent.createMediaBuy({
    account,
    idempotency_key: crypto.randomUUID(),
    packages: inlineCreativesForPackages(packagesWithRefs, creatives, { assignments }),
  });
} else {
  throw new Error('Seller supports neither creative library sync nor inline creative uploads.');
}
```

`supportsSyncCreatives(caps)` keys off `creative.has_creative_library`. It does
not infer support from tool-list presence or from
`media_buy.features.inline_creative_management`.
Only use `inlineCreativesForPackages()` as the fallback when
`caps.features.inlineCreativeManagement` is true. When supplying assignments
for create payloads, make sure each package has a stable key such as
`context.buyer_ref`, or pass a custom `packageId` resolver.

For post-create replacement, build the same package-scoped patch and preflight
it against the current buy before dispatching:

```ts
import { inlineCreativesForPackages, preflightUpdateMediaBuy } from '@adcp/sdk';

const patch = {
  media_buy_id: currentBuy.media_buy_id,
  idempotency_key: crypto.randomUUID(),
  packages: inlineCreativesForPackages([{ package_id: 'pkg_1' }], creatives, {
    assignments: [{ creative_id: 'cre_1', package_id: 'pkg_1', weight: 100 }],
  }),
};

const preflight = preflightUpdateMediaBuy(currentBuy, patch);
if (!preflight.ok) {
  throw new Error(`Creative replacement unavailable: ${preflight.denials[0].reason}`);
}

await agent.updateMediaBuy(patch);
```

Each mutating leg needs its own `idempotency_key`. Do not reuse a
`sync_creatives` key for the fallback `create_media_buy` or `update_media_buy`
request.

## Creative libraries and legacy format projection

A raw `sync_creatives` request contains package assignments but not the
seller's product declarations, so the SDK cannot safely derive a custom legacy
format ID from `format_kind` alone. Supply the assignment-scoped package or
product selectors through `creativeFormatProjection`:

```ts
await agent.syncCreatives(
  {
    account,
    idempotency_key: crypto.randomUUID(),
    creatives,
    assignments,
  },
  undefined,
  {
    creativeFormatProjection: {
      selectorContainers: selectedPackages,
      legacyFormatDefinitions: sellerLegacyFormats,
    },
  },
);
```

The same pure functions are available from the explicit
`@adcp/sdk/v2/projection` migration subpath for composition outside a client call:
`projectCreativeForDelivery()`, `projectMediaBuyCreativesForDelivery()`, and
`projectSyncCreativesForDelivery()`.

When these helpers emit a legacy `format_id`, they also map assets to the
definition's `asset_id` keys. Definitions come from the bundled reference
catalog, or from an optional `legacyFormatDefinitions` array supplied to
any of the three helpers. Caller definitions take precedence and must match
both the format agent URL and ID. No network lookup occurs during projection.

The client methods `syncCreatives`, `createMediaBuy`, and `updateMediaBuy`
also accept these definitions in `options.creativeFormatProjection.legacyFormatDefinitions`.
Pass the seller's legacy `list_creative_formats` definitions when its asset slots
differ from the bundled catalog. For example, an explicit `url` slot with
`requirements.url_type: 'tracker_pixel'` enables pixel-tracker conversion even
when the seller negotiates AdCP 3.1 and the request projects to a legacy `format_id`.
Advertising 3.0 alongside 3.1 alone does
not enable conversion. The definitions stay local and are copied before discovery.

Existing declared asset keys keep their values. Other assets move only to one
unoccupied slot with the same `asset_type`; URL assets must also match
`requirements.url_type`, and pixel trackers must match the slot's `event`.
Custom tracker events also match `custom_event_name`. Definitions containing
repeatable groups retain all asset keys; projection does not infer group membership.
Unmatched assets, ambiguous matches, and assets competing for the same slot
keep their original keys. Unknown definitions leave assets unchanged. Canonical
delivery retains its asset keys, and projection never mutates the caller's data.

A legacy `sync_creatives` record carries one `format_id` for a creative,
however many packages it is assigned to. On the legacy wire the SDK resolves
the creative against each assigned package independently, then reconciles
those refs by constraint satisfaction rather than requiring them to be
identical:

- Every package must resolve to the same format (`agent_url` and `id`).
- `width`/`height` and `duration_ms` are constraints a package either leaves
  open or restricts to a set of values. A package restricts one through its
  resolved ref or, where the ref is silent, through its declarations: their
  `params` (one size, a `sizes` list, an exact duration or a
  `duration_ms_range`) or the catalog entry for the id. A package with several
  declarations accepts what any of them accepts, and nothing else: a package
  declaring 640x360 and 940x529 refuses a 300x250 that another package states.
  A package that leaves a constraint open accepts any value.
- The shared ref takes `width`/`height` and `duration_ms` from the resolved
  refs only. Values that only declarations state are used to detect conflicts
  but are never copied into the shared ref, because the shared ref must match
  what each package resolves to on its own. When no ref states a size, the
  shared ref omits it.
- Projection refuses only when no value satisfies every package.

So a VAST creative assigned to nine packages declaring `video_vast` at 940x529
and three declaring an unsized `video_vast` is sent once as
`{ id: 'video_vast', width: 940, height: 529 }`, and when no package states a
size the shared ref omits it.

When no single ref satisfies every package, projection throws a
`CreativeFormatProjectionError`. Its `details.conflicts` names each conflicting
constraint (`format_id`, `size` or `duration`) with each package's allowed
values, and the message repeats it. `details.package_refs` lists each
`package_id` and resolved `ref`, or the remaining `refs` and a `reason` when
that package cannot resolve uniquely.

This reconciliation is a legacy-wire concern only. On the canonical wire each
package checks the creative against its own `format_kind` and `params`, so
there is no shared identity to agree on and canonical delivery is unchanged.

Canonical creatives assigned to multiple packages need selector evidence or a
resolver answer for every package; a missing package cannot borrow another
package's ref. Creative resolver calls in this path receive that package's
container, including its `package_id`, rather than the pooled selector wrapper.
Already-legacy creatives with a stated size also refuse conflicting package
evidence. Supply a selector per assigned package, and update creative resolvers
that read `selector_containers` to read the package container directly.

`creativeFormatProjection.playerSizedRefs: 'omit_unstated_size'` (the seventh
argument of the pure `projectSyncCreativesForDelivery()` helper) is deprecated
and will be removed in 18.0.0. Mixed sized and unsized packages no longer need
it. Until removal it is still accepted, and keeps its earlier meaning only
where the declarations conflict: `video_vast` and `audio_vast` packages that
state different player sizes but agree on owner, ID, duration and other format
parameters, for a creative that states no size. Setting it asserts that the
seller accepts a ref without `width` and `height`, and the shared ref then
omits them while keeping the agreed duration. Whether a stated VAST size is a
hard requirement or a player hint is a fact about the seller's format, so it
belongs in the seller's format definition or the AdCP format params rather
than in host policy; see
[adcontextprotocol/adcp#8583](https://github.com/adcontextprotocol/adcp/issues/8583).

Capability resolution uses the client's
emitted wire release pin: AdCP 3.2+ is canonical by contract, 3.0 is legacy, and 3.1
checks the explicit `media_buy.features.canonical_creatives` declaration. A
3.1 peer without the feature is deliberately
`unknown` because a 3.1 version claim does not prove the runtime accepts
canonical creatives. For MCP peers the client then inspects the advertised
input schema for the current tool only; support advertised by another creative
tool is never reused.

For a seller proven to serve AdCP 3.1, an otherwise unknown write uses canonical
delivery when every selected option and creative is covered by the seller's own
`format_options`. This follows the 3.1 buyer rule to prefer advertised format
options over dual-emitted legacy IDs. Creative option references and kinds must
match, including declared slots and dimensions. Sync assignments must all have
matching selector containers. Explicit legacy capabilities or tool schemas take
precedence; experimental declarations and options synthesized by the SDK from
legacy IDs do not establish canonical support. This also works when a 3.2 buyer
negotiates down to a 3.1 seller.

Supply the selected product or the result of `packageRefsForFormatOptions()` in
`creativeFormatProjection.selectorContainers`. Include `package_id` when using
assignments. After serializing a selection, include `product_id` so the same
client can recover the seller declaration from account-scoped product discovery,
including product-cache hits. Product evidence applies to that request only.
The seller remains responsible for full manifest validation.

Canonical fallback requires affirmative evidence from this client's product
discovery and an advertised `supported_versions` entry proving the seller serves
3.1. The fallback uses synchronous discovery and successful conditional catalog
revalidation. A saved product on a fresh client, including one synthesized from
legacy IDs, cannot establish support by its shape alone. Rediscover the product
in the current account and authorization scope first. Evidence expires after
the discovery TTL (five minutes by default); product-cache hits do not extend
it. Authorization changes and discovery invalidation invalidate the evidence.
Request-scoped custom transports require explicit capability or tool-schema
support and do not reuse this inferred product evidence.

Assignment-only sync and updates containing only an existing `package_id` keep
their existing wire behavior. Pass the matching selectors for this request to
use the product-based fallback; package IDs alone do not establish support.
Without assignments, each creative must match every supplied container; use
assignments or split mixed-format batches when the products accept different kinds.

Without matching product evidence, unknown peers receive a legacy projection
only when the selected product provides one unambiguous ref. Ambiguous or
unavailable mappings throw `CreativeFormatProjectionError` before transport.

Schema inspection follows local JSON Pointer `$ref` targets, including `$defs`,
and retains the complete listed document through shared discovery-cache reuse.
Unused definitions and annotations do not establish support. External references,
named anchors, and dynamic references are not resolved; inspection never fetches
schema URLs. Cycles and traversal limits cannot force a guessed wire mode.

Before building creatives, inspect the tool's wire evidence:

```ts
const mode = await agent.resolveCreativeFormatWireMode('sync_creatives');
```

This method is available on `AgentClient` and `SingleAgentClient`, accepts
`sync_creatives`, `create_media_buy`, or `update_media_buy`, and shares the
write path's capability discovery, tool-schema fallback, and buyer wire pin.
This context-free check does not inspect a write's product options, so an
`unknown` result can still become canonical for a matching 3.1 write as described
above.
It reuses fresh cached or primed evidence; cold discovery may make read calls,
but it sends no mutation. Pass `{ signal, transport }` as the optional second
argument to use the same cancellation and transport scope as the write.

The result is `canonical`, `legacy`, or `unknown` (`CreativeFormatWireMode`).
For older peers without matching product evidence, `unknown` means projection
still requires one unambiguous legacy reference. It does not promise canonical
support. Conflicting capability/schema evidence or missing release proof with
a 3.2+ buyer pin throws `CreativeFormatCapabilityError`, as during a write.
The standalone `resolveCreativeFormatWireMode(capabilities, version)` helper
only evaluates capability declarations; use the client method when you need
the tool-schema fallback too.

For a manual projection check, import `projectSyncCreativesForDelivery` from
`@adcp/sdk/v2/projection`. Matching the write requires the same mode, converter,
resolver, and selector inputs. Include a selector container for every assigned
`package_id`, including packages that have no selected format; `syncCreatives()`
adds those missing containers automatically. Client-configured catalogs and
cached package routes can also supply projection inputs, so this helper is not
a dry run of the client's full projection pipeline.

Resolve again after installing new evidence with `primeCapabilities()`, calling
`SingleAgentClient.refreshCapabilities()`, or changing authorization or
transport scope. Scoped transports rediscover evidence for each call.

Use `packageRefsForFormatOptions(product, selectedIds)` when authoring package
selectors. It returns only canonical `format_option_refs`. The SDK carries any
legacy downgrade material in module-private weak storage, which survives package
object spread but is absent from JSON, reflection, and public types. A bounded,
per-client route cache also lets a product selected after a JSON round trip
downgrade during the same client lifetime. The registry deliberately does not
guess a legacy identity from `format_kind + params`. Account-scoped
create/update/get-media-buy completions also learn exact package routes,
including polling, deferred, and webhook completions. A creative assigned to
multiple packages downgrades only when every package resolves to the same
legacy ref set.

For a canonical seller whose product declares only legacy `format_ids`, those
authored option refs name IDs minted locally by the SDK. After discovering the
product with the same client, create/update writes send the equivalent
`format_kind` + `params` selector and sync writes drop undeclared creative pins.
Product-cache snapshots retain this seller-origin evidence privately. A selection
that needs multiple direct selectors, or an undeclared custom format that needs
its schema identity, fails with `ADCP_CREATIVE_FORMAT_PROJECTION_FAILED` before
dispatch. Seller-declared option refs remain unchanged. Re-run `getProducts()`
after restarting before writing selections derived from legacy-only products.

After a process restart, re-run product and media-buy reads that carry enough
selector context or configure the explicit canonical-to-legacy resolver below.
An accountless write never consumes a tenant-scoped cached package route based
only on `package_id`; include the account or configure the resolver so that
case fails cleanly instead of risking cross-tenant delivery. This applies to
standard and custom formats alike; do not persist agent URLs in canonical
application objects.

The primary `createMediaBuy()`, `updateMediaBuy()`, and `syncCreatives()`
TypeScript signatures accept canonical creative assets only. Protocol tools and
staged migrations that still hold generated legacy request objects use the
explicit `createMediaBuyLegacy()`, `updateMediaBuyLegacy()`, and
`syncCreativesLegacy()` compatibility methods; these still normalize through
the same fail-closed boundary.

## Custom legacy formats

Publisher and AAO community catalogs can participate without making network
I/O part of the pure projector. Resolve and validate the catalog first, then
configure immutable snapshots in precedence order (publisher before mirror):

```ts
import { projectionAdaptersFromCatalogSnapshots } from '@adcp/sdk';

const projectionCatalogs = [publisherSnapshot, communityMirrorSnapshot];
const client = new AgentClient(
  agent,
  projectionAdaptersFromCatalogSnapshots(projectionCatalogs)
);
```

That helper configures both directions from the same catalog data: exact legacy
refs upgrade during discovery, and stable `format_option_id` selections resolve
back to the catalog-authored legacy refs for create/update/sync after process or
JSON boundaries. It accepts only publisher-scoped, one-to-one routes and checks
the canonical kind and overlapping params before downgrading. Split multi-size
routes into stable option IDs or use a custom durable resolver that narrows from
canonical params. This is preferable to maintaining two hand-written callbacks
for temporary seller migrations. If an application needs custom reverse logic,
it can still configure `canonicalFormatLegacyResolver` directly.

For injected publisher/community catalogs, only an exact, URL-sensitive
`v1_format_ref` authorizes legacy-to-canonical projection. A public declaration
with the same `format_option_id` is not an alias by itself, and
`canonical_formats_only: true` explicitly forbids using that declaration as a
legacy mapping. This matters for the public Snap mirror:
`https://creative.adcontextprotocol.org/translated/snap/adagents.json` makes
Snap's canonical publisher formats publicly discoverable, but its current
canonical-only entries do not authorize guessed Snapchat legacy tuples.

The bundled AAO catalog recognizes both the current
`https://creative.adcontextprotocol.org/` owner and the historical
`https://adcontextprotocol.org/` owner used by early deployments such as
Optimera. For inbound legacy discovery it also recognizes an exact bare ID
with one unique AAO-published meaning, covering sellers that copied AAO IDs
but emitted their own creative-agent URL. Duplicate IDs and contradictory
inline dimensions or duration fail closed, and the seller's original tuple is
preserved by the bounded same-client route cache for legacy delivery. Generated
option IDs are stable across seller array reordering. After a process boundary,
configure a durable catalog adapter or reverse resolver; canonical data cannot
reconstruct an arbitrary owner. Projection is semantic normalization only: it
does not fetch or authorize the source URL, and later network contact remains
subject to the SDK's normal HTTPS and SSRF policy. This fallback never applies
to a bespoke ID.

The bundled registry cannot infer semantics for a seller-specific
`{ agent_url, id }`. Such an inbound creative fails closed unless a
`legacyFormatConverter` returns a valid canonical declaration. Bespoke shapes
use the protocol's custom escape hatch; `format_option_id` gives converted
creative assets a stable canonical reference:

```ts
const legacyFormatConverter = ({ formatId }) => ({
  format_kind: 'custom',
  format_option_id: 'homepage-takeover',
  format_shape: 'multi_placement_takeover',
  format_schema: {
    uri: `https://seller.example/formats/${formatId.id}.json`,
    digest: 'sha256:<64 lowercase hex characters>',
  },
  params: {},
});
```

Configure it once as `legacyFormatConverter` on `SingleAgentClient`/
`AgentClient`, or override it for one call in `getProducts()` and creative
delivery task options. The configured converter applies consistently to
discovery, `createMediaBuyLegacy()`, `updateMediaBuyLegacy()`,
`syncCreativesLegacy()`, async continuations, and webhooks. Server adopters use
the `legacyCreativeFormatConverter` option on `createAdcpServerFromPlatform()`.
When product-format lookup requires a database or seller catalog call, use the
asynchronous `legacyCreativeFormatResolver` instead:

```ts
createAdcpServerFromPlatform(platform, {
  name: 'Seller',
  version: '1.0.0',
  legacyCreativeFormatResolver: async ({ formatId, accountId, servedAdcpVersion, signal }) =>
    catalog.resolveCanonicalDeclaration(formatId, { accountId, servedAdcpVersion, signal }),
  legacyCreativeFormatResolverTimeoutMs: 10_000,
  legacyCreativeFormatResolverConcurrency: 8,
});
```

The resolver runs only after bundled/standard projection fails, receives the
exact owner-qualified format tuple plus non-secret request context, and may
resolve independent formats concurrently. Returning no declaration, throwing,
or returning a malformed declaration fails closed with `INVALID_REQUEST`.
The SDK runs at most eight lookups concurrently and aborts the shared resolver
phase after ten seconds by default. Resolvers should honor the supplied
`signal`; tune the timeout and 1–64 concurrency options for the backing catalog.

When a `SalesPlatform.getProducts` implementation already has owner-scoped
catalog snapshots, attach them directly to each returned product instead of
performing another lookup:

```ts
import { getHydratedLegacyFormatIds } from '@adcp/sdk/server';

const sales = {
  getProducts: async () => ({
    cache_scope: 'account',
    products: [{ ...legacyProduct, projectionCatalogs: [publisherSnapshot] }],
  }),
  createMediaBuy: async request => {
    const exactSellerRoutes = getHydratedLegacyFormatIds(request.packages[0].product);
    return proxyCreateToLegacySeller(request, exactSellerRoutes);
  },
};
```

`projectionCatalogs` is framework-only metadata: the SDK consumes it before
projection and never emits it on the buyer wire. With `ctxMetadata` storage
configured, the SDK persists the resolved owner-qualified routes privately and
restores them for hydrated create packages and update `packages`/
`new_packages`. Read them with `getHydratedLegacyFormatIds`; they remain absent
from serialized canonical products and buyer responses.

Modern server platform handlers always receive canonical creatives. An invalid
explicit conversion is rejected with `INVALID_REQUEST`; an unmapped legacy ref
without a converter is never guessed as one of the 12 standard canonical
kinds. Discovery keeps partially mapped products and adds sanitized errors for
the missing options. A wholly unmappable product is omitted from the canonical
list because canonical `format_options` has `minItems: 1`; its non-fatal
`FORMAT_PROJECTION_FAILED` remains in `errors[]`. That standard error array is
the portable surface across agent hops; `projection.diagnostics` is an SDK
convenience view. `getProductsLegacy()` remains available to migration tooling
that needs the original ref or complete legacy product list. The legacy ref
never leaks into canonical adopter code.

Legacy `format_ids: []` is a valid format-agnostic product, not a failed
mapping. Because the canonical surface cannot emit the schema-invalid
`format_options: []`, it omits that product and reports
`CANONICAL_PRODUCT_FORMATS_UNAVAILABLE` with
`reason: 'legacy_format_list_empty'`. Use `getProductsLegacy()` when a
migration workflow needs to preserve format-agnostic legacy products.

### Persisted canonical formats on a legacy server wire

`legacyCreativeFormatConverter` handles legacy input. The reverse direction
uses the separate `canonicalFormatLegacyResolver` option. This is necessary
for any standard or custom format when a new client process has only canonical
database state and its SDK-private downgrade route is intentionally gone:

```ts
createAdcpServerFromPlatform(platform, {
  name: 'Seller',
  version: '1.0.0',
  adcpVersion: '3.0.12',
  canonicalFormatLegacyResolver: context => {
    if (
      context.source === 'product' &&
      context.declaration.format_option_id === 'homepage-takeover'
    ) {
      return {
        agent_url: 'https://seller.example/formats',
        id: 'homepage_takeover',
      };
    }
    if (
      context.source === 'creative' &&
      context.creative.format_option_ref?.format_option_id === 'homepage-takeover'
    ) {
      return {
        agent_url: 'https://seller.example/formats',
        id: 'homepage_takeover',
      };
    }
    return undefined;
  },
});
```

Resolver output is validated before it reaches the wire. A creative or package
selector must resolve to exactly one format ID; product declarations may
resolve to multiple IDs. Invalid, throwing, or ambiguous output fails closed.
`canonical_formats_only: true` is an absolute opt-out and is never overridden
by the resolver.
