---
'@adcp/sdk': minor
---

Add typed, multi-dimension targeting command-state conformance vectors and operation-named input aliases; provide a same-instance capability-preflight factory with typed refusal reasons and cold-discovery guidance; and make finite response-preview capture asynchronous while skipping SSE, non-text, missing/invalid-length, and over-limit bodies with `responseBodyTruncated: true`.

Recognize the unpublished legacy `requires_proposal` action mode without granting mutation authority: preflight now returns `mode_mismatch` with a proposal-lifecycle recovery hint, including through the seller-side error echo.
