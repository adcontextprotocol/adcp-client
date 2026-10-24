# Migrating from SDK 16 to 17

SDK 17 is being prepared for AdCP `3.3.0-beta.0`. This guide describes the
prepared creative mapping change; the protocol bundle is not yet integrated
and the checkout still pins AdCP 3.2.5. SDK 17 publication waits for the exact
published bundle and its integration checks. SDK 16 retains the previous mapping.

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

Use the seller's declared slot, typically `html_creative`. Set the creative's
`format_parameters.width` and `format_parameters.height` when selecting among
multiple sizes under the stable AdCP 3.2.5 types. The SDK also accepts a single
unambiguous rendered size on newer `zip`, `html`, or `display_tag` assets when
`format_parameters` is absent; those asset-size fields are a newer protocol
extension, not part of the pinned 3.2.5 asset types.

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
existing AdCP 3.2.5 display-tag wire contract. Preparing this mapping does not
change the protocol pin; the AdCP 3.3 bundle migration will be documented here
when that bundle is integrated.
