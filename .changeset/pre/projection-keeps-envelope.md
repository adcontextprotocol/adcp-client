---
'@adcp/sdk': patch
---

Version translation no longer removes protocol envelope fields. When a response was converted down to an older release whose task schema didn't compose the protocol envelope (the 3.2 proposal-flow responses, which AdCP 3.2.x and 3.3 fix as DR-0036 correction (b)), the schema projection treated `status`, `message`, `context` and the other envelope fields as newer-only and removed them, so a 3.2 buyer could receive a 3.3 server's `list_products` response without its `status`. The projection now keeps every property the release's protocol and version envelopes declare at the payload root.
