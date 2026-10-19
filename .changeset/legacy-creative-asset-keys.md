---
'@adcp/sdk': patch
---

Map creative asset keys to known legacy format asset IDs when projecting delivery to a v1 format_id. Match URL roles and pixel-tracker events, preserve occupied keys, and leave unmatched or ambiguous assets unchanged. Apply the mapping to creative sync and inline media-buy create/update requests, with optional caller-supplied format definitions on the pure projection helpers. Fixes #3347.
