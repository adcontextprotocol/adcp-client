---
'@adcp/sdk': patch
---

Align the conformance/storyboard harness with the 3.1 beta compliance cache and request-signing vectors.

Adds request-signing enforcement for raw JSON-RPC protocol methods such as `tasks/cancel`, updates generated schema aliases, and teaches the storyboard runner about the latest compliance probe pseudo-steps.
