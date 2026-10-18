---
'@adcp/sdk': patch
---

Honor the AdCP 3.1 buyer rule when choosing the creative wire shape. When capabilities and the current tool schema leave support unknown, a request covered by seller-advertised format options now uses canonical delivery, including canonical-only products and 3.2 buyers negotiating down to 3.1. Apply the decision to creative sync and inline create/update media-buy requests, preserve explicit legacy decisions, and require matching evidence for every creative and assignment. Keep SDK-synthesized and experimental options from establishing support. Recover seller declarations through product-cache hits and serialized selectors carrying a product ID, without promoting request-local evidence into a global capability. Completes point 2 of #3312; the existing guarded dual-emission pairing continues to handle legacy delivery.
