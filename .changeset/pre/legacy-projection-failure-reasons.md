---
'@adcp/sdk': patch
---

Legacy creative projection failures (`ADCP_CREATIVE_FORMAT_PROJECTION_FAILED`) now say which constraint failed. An `html5` creative offered only HTML-markup formats points at the SDK 17 `display_tag` inline-markup migration. A `display_tag` delivery type the seller's refs don't accept names both delivery types, and a rendered size with no matching ref names the size. Ambiguous sized refs suggest `format_parameters.width`/`height`. Error codes and selection behaviour are unchanged; only the message text differs.
