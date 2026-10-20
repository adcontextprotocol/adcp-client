---
'@adcp/sdk': minor
---

Project the AAO HTML-markup legacy formats (`display_html` and every `display_WxH_html`) to `display_tag` with inline-markup delivery instead of `html5`, following adcontextprotocol/adcp#8339. `html5` describes a seller-hosted zip bundle. These formats take HTML markup that the seller renders verbatim.

- **Discovery.** The bundled catalog now annotates these formats with an `html_creative` `display_tag` slot and `supported_delivery_types: ['inline_markup']`. The projector copies the new catalog hint `canonical.supported_delivery_types` into `params.supported_delivery_types`, alongside the format's fixed width and height.
- **Legacy delivery.** A `display_tag` inline-markup creative selects the seller's exact `display_WxH_html` ref. Selection matches the size from `format_parameters`, or from the creative's single rendered `zip`/`html`/`display_tag` asset size when `format_parameters` is absent. The markup is emitted byte-for-byte as the legacy `html` asset's `content` under `html_creative`. A `display_tag` creative only matches refs that accept its delivery type, so inline markup never routes to the tag-URL `display_js`, and a tag URL never routes to an `_html` format.
- **Canonical reads.** On the canonical wire, a legacy `html_creative` asset reads back as an inline-markup `display_tag` asset with `markup_type: 'standard'`.
- **Behavior change (intended).** An `html5` zip creative no longer matches a product that offers only these formats. `resolveCanonicalFormatKind` and `canonicalDeclarationFromBareId` now return `display_tag` for `_html` ids, including the `assetType: 'html5'` local alias. `display_js` is unchanged.
