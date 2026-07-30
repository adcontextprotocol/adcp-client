---
'@adcp/sdk': patch
---

Soft-fail legacy format_ids projection for canonical wire mode. When a package's legacy format_ids cannot be converted to canonical format_option_refs, return the package unchanged rather than throwing so get_media_buys responses for existing buys remain usable.
