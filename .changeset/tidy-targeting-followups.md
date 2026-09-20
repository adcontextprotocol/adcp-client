---
'@adcp/sdk': minor
---

Add typed, multi-dimension targeting command-state conformance vectors and operation-named input aliases; provide a same-instance capability-preflight factory with typed refusal reasons and cold-discovery guidance; and make bounded response-preview capture asynchronous while skipping SSE, non-text, and explicitly over-limit bodies with `responseBodyTruncated: true`. Text bodies without a usable length are captured through the same size- and time-bounded reader.

Recognize the unpublished legacy `requires_proposal` action mode without granting mutation authority: local preflight returns `mode_mismatch` with a proposal-lifecycle recovery hint, while seller errors omit the legacy action echo to remain valid against the current wire schema.
