# Migrating from SDK 16 to 17

SDK 17 beta pins the signed AdCP `3.3.0-beta.0` release. Use the beta in
development and staging; production remains on SDK 16 and AdCP 3.2.

## Protocol and discovery

The SDK packages the exact 3.3 beta schema and compliance bundle alongside
maintained AdCP 3.2.7, 3.1.29 and 3.0.25 bundles. A seller must advertise
`3.3-beta.0` (or its full bundle version, `3.3.0-beta.0`) before the buyer
selects that preview. A different beta, a moving `3.3-beta` alias, or a
served-version echo alone does not establish support. The buyer can negotiate
an older stable release the seller advertises. Missing or synthetic capability
evidence cannot authorize a preview request.

`AgentClient` and `SingleAgentClient` expose `listCollections()` and
`listProposals()`, including typed completion handlers. The corresponding
server handlers are `mediaBuy.listCollections` and `mediaBuy.listProposals`,
or optional methods on `MediaBuyLifecyclePlatform`. Their synchronous results
use `outcome` and do not acquire a synthetic task `status` field.

## Account resolution and optional declarations

On a served AdCP 3.3 route, buyer-supplied account references require a
reference-aware resolver. Unresolved references return `ACCOUNT_NOT_FOUND`
before the handler runs, even when `strictAccountReferences: false` was set
for an older compatibility route. `list_accounts.account` is a filter.
Discovery and negotiation resolvers receive `provisioning: false`; they must
not create or activate accounts or accept billing terms.

The generated types and validators include the beta's optional catalog
ingestion, onboarding, DOOH location/inventory, audience-size, collection,
proposal and creative declarations. If a seller declares `catalog_ingestion`,
its handlers must enforce the advertised types, modes, formats and limits
before mutation. Review fields that previously used an open extension name:
`catalog_ingestion` now has an object schema, and `ext.adcp` is reserved.

Asset unions gain `video_brief`; update exhaustive switches. The experimental
build-creative evaluator agent form uses `agent_url` instead of `evaluator_id`.
Provide an allowlisted evaluator URL explicitly; an opaque old evaluator ID
cannot be converted into a trustworthy URL by the SDK.

The `@adcp/sdk/identity-3.3` and Web Bot Auth opt-in remains experimental.
Changing the protocol pin does not enable that opt-in or graduate its APIs.
Existing RFC 9421 signing and verified agent-resolution checks remain active.

## HTML-markup formats use inline-markup display tags

The AAO legacy formats `display_html` and `display_WxH_html` accept HTML
markup rendered by the seller. SDK 17 projects them to canonical `display_tag`
with `supported_delivery_types: ['inline_markup']`. The previous `html5`
classification described a zip bundle and prevented correctly classified
third-party markup from matching these formats.

If your application created `html5` creatives containing an `html` snippet for
these formats, change the creative to `format_kind: 'display_tag'` and send its
markup as an inline-markup asset:

```typescript
const asset = {
  asset_type: 'display_tag',
  delivery_type: 'inline_markup',
  markup_type: 'standard',
  markup: legacyHtmlAsset.content,
};
```

Use the seller's declared slot, typically `html_creative`. Explicit
`format_parameters.width` and `format_parameters.height` take precedence when
selecting among multiple sizes. AdCP 3.3 also carries rendered dimensions on
`zip`, `html`, and `display_tag` assets; when `format_parameters` is absent,
the SDK uses one unambiguous rendered asset size.

Update code branching on `resolveCanonicalFormatKind` or
`canonicalDeclarationFromBareId`: `_html` IDs now resolve to `display_tag`,
including when the local `assetType: 'html5'` hint selects an `_html` ID.
Actual zip creatives remain `html5` and cannot match HTML-markup-only products.

Legacy delivery preserves the seller's format URL and size and emits the markup
bytes in `html_creative.content`. Tag URLs and inline markup select only legacy
refs that accept their delivery type. A paired redirect or inline-markup creative
cannot use a ref that accepts only tag URLs. Multi-size tag-URL declarations keep
their seller-asserted refs rather than expanding into inline-markup HTML formats.
This applies to every unsized representative ref: without a size-bearing ID,
the SDK cannot establish a catalog family for expansion and retains the
`FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE` diagnostic.

When a seller publishes a standard format ID under its own creative-agent URL,
the SDK preserves that URL and converts inline markup to legacy HTML. It keeps
the asset keys unless an exact or caller-supplied format definition identifies
the seller's slots; a matching bare ID alone does not establish those slot names.

The legacy HTML asset has no fields for `markup_type` or `macro_declarations`.
Those metadata fields do not round-trip; when a legacy HTML creative is converted
for a canonical request, its markup type defaults to `standard`. Existing legacy
request assets remain unchanged on the legacy wire. Explicit seller declarations
retain their format kind and delivery types.

These changes follow [adcp#8339](https://github.com/adcontextprotocol/adcp/issues/8339)
and [adcp#8357](https://github.com/adcontextprotocol/adcp/pull/8357). They use the
existing inline-markup display-tag contract. This mapping changes public
helper return values and projected creative wire shapes, so it ships in the
SDK 17 major release. SDK 16 keeps its existing HTML-markup mapping.

On 3.3 routes, the server automatically advertises the required experimental feature IDs for registered handlers: `list_collections` adds `media_buy.collection_catalog` and `media_buy.collection_cards` and `list_proposals` adds `media_buy.open_opportunities`. These APIs remain experimental in the protocol beta.

Account verification applies to the selected request release. Unversioned callers select the server default, now the 3.3 beta. On 3.3 routes, `required_for_products` enforces `ACCOUNT_REQUIRED`; set `strictAccountReferences: true` to apply the same policy to older routes. Proposal discovery always requires an authenticated caller and a resolved account, including when schema validation is off.

The direct governance helpers and governance middleware retain their configured client protocol pin. For a stable governance agent, use a client configured with `adcpVersion: '3.2.7'`; `syncPlans` and `getPlanAuditLogs` also accept an explicit `wireAdcpVersion` in their task options. Per-agent negotiation for these direct governance paths remains follow-up work.

AdCP 3.3 definition pins require revalidation against the current third-party published definitions at commitment time. This beta's synchronous standalone commercial-terms verifier cannot perform that source verification: it fails closed on definition pins, publisher format references, and any placement/collection/signal targeting. Use the seller-served stable 3.2.7 contract for existing snapshot-verification flows until pin verification is supported. It continues to compare ordinary 3.3 commercial snapshots and enforces collection-list uniqueness by reference identity.
