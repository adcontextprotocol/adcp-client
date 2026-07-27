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
    },
  },
);
```

The same pure functions are available from the explicit
`@adcp/sdk/v2/projection` migration subpath for composition outside a client call:
`projectCreativeForDelivery()`, `projectMediaBuyCreativesForDelivery()`, and
`projectSyncCreativesForDelivery()`. Capability resolution uses the client's
emitted wire release pin: AdCP 3.2+ is canonical by contract, 3.0 is legacy, and 3.1
checks the explicit `media_buy.features.canonical_creatives` declaration. A
3.1 peer without the feature is deliberately
`unknown` because a 3.1 version claim does not prove the runtime accepts
canonical creatives. For MCP peers the client then inspects the advertised
input schema for the current tool only; support advertised by another creative
tool is never reused. Unknown peers receive a legacy projection only when the
selected product provides one unambiguous ref. Ambiguous or unavailable mappings throw
`CreativeFormatProjectionError` before transport.

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

Only an exact, URL-sensitive `v1_format_ref` authorizes legacy-to-canonical
projection. A public declaration with the same `format_option_id` is not an
alias by itself, and `canonical_formats_only: true` explicitly forbids using
that declaration as a legacy mapping. This matters for the public Snap mirror:
`https://creative.adcontextprotocol.org/translated/snap/adagents.json` makes
Snap's canonical publisher formats publicly discoverable, but its current
canonical-only entries do not authorize guessed Snapchat legacy tuples.

The bundled AAO catalog recognizes both the current
`https://creative.adcontextprotocol.org/` owner and the historical
`https://adcontextprotocol.org/` owner used by early deployments such as
Optimera. This is an explicit alias; matching never falls back to a format ID
owned by an unrelated URL.

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
