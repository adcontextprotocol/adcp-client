---
'@adcp/sdk': patch
---

Follow the AdCP 3.1 reference-catalog erratum (adcontextprotocol/adcp#8339). The HTML-markup legacy formats (`display_html` and every `display_WxH_html`) now project to `display_tag` with an `html_creative` (`html`) slot instead of `html5`. `html5` describes a seller-hosted zip bundle. These formats take HTML markup that the seller renders verbatim. The bundled catalog's HTML entries now match the 3.1.x catalog exactly, including `display_320x50_html` and `display_300x50_html`. A `display_tag` creative with an `html_creative` asset routes to the seller's `display_WxH_html` ref. An `html5` zip creative no longer matches a product that offers only these formats. This is intended.
