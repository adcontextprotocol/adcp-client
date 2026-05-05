---
'@adcp/sdk': patch
---

fix(get_products): pass v3 channel names through unchanged to v2 servers

`adaptGetProductsRequestForV2` previously rewrote `olv → video`, `ctv → video`, `streaming_audio → audio`, and `retail_media → retail` on the way out. v2.5.3 of the AdCP spec aligned the channel enum with v3 taxonomy, and v2 servers running v2.5.3+ reject the older names with `-32602 Schema validation failed`. We now leave channel filters untouched in the v2 adapter so v3 names reach those servers as-is.

Response-side `normalizeProductChannels` is unchanged: legacy v2 servers that still return `video`/`audio`/`retail` continue to be normalized up to v3 taxonomy on the read path.
