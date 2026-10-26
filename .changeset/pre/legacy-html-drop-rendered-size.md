---
'@adcp/sdk': patch
---

Stop copying AdCP 3.3 rendered dimensions onto the legacy `html` asset (adcp-client#3436). When SDK 17 projects a canonical inline-markup `display_tag` creative onto an HTML-markup legacy format (`display_html` or `display_WxH_html`, adcontextprotocol/adcp#8339), the legacy `html_creative` is now `{ asset_type: 'html', content }`, plus `provenance` when the asset has it. The asset's `width`, `height` and `sizes` are no longer copied. This matches the AdCP vector `inline-markup-selects-the-exact-sized-legacy-ref`.

Those fields were added in AdCP 3.3, and the legacy wire only serves sellers before 3.2. In 17.0.0-beta.0 the version translation then refused the copied fields, so `syncCreatives`, `createMediaBuy` and `updateMediaBuy` threw `ProtocolFeatureUnsupportedError` for any sized inline-markup creative sent to a 3.0 or 3.1 seller.

Unchanged:

- The rendered size, or `format_parameters.width`/`height`, still selects the sized legacy ref, and the selected `display_WxH_html` ref carries the size.
- Sellers on 3.2 or later are on the canonical wire, which this change does not touch. A 3.3 seller gets the `display_tag` with its rendered size as sent.
- Reading a legacy `html_creative` canonically still moves the asset's own `width`/`height`/`sizes` onto the `display_tag`, and invents no size from the format ref.
