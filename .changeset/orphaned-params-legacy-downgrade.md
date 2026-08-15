---
'@adcp/sdk': patch
---

Fix `createMediaBuy`/`updateMediaBuy` leaving an orphaned `params` object on a package after downgrading a canonical `format_kind` + `params` selector to the legacy `format_ids` shape, which produced a wire payload matching neither the canonical nor legacy contract.
