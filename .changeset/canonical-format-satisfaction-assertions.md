---
"@adcp/sdk": minor
---

Add storyboard `canonical_format_satisfaction` validation for canonical format create-time assertions.

The check compares actual `create_media_buy` package selectors against prior `get_products` product format declarations, including canonical `format_option_refs`, legacy `format_ids` normalized through `v1_format_ref` or catalog projection, richer param containment, under-specified selector rejection, and format-specific rejection diagnostics.
