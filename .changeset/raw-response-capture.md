---
'@adcp/client': patch
---

Internal: MCP and A2A protocol adapters can now capture raw HTTP responses (status, headers, body, latency) when `withRawResponseCapture(fn)` is active. Exported from `src/lib/protocols/rawResponseCapture.ts`. Conformance-only infrastructure — the wrapper is a pass-through when no capture slot is set, so regular clients pay only one AsyncLocalStorage lookup per request. Foundation for the uniform-error-response fuzz invariant (issue #731).
