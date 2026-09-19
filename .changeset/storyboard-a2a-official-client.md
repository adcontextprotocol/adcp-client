---
'@adcp/sdk': patch
---

Grade request-signing vectors over A2A by signing the request the official `@a2a-js/sdk` client emits.

An A2A run previously reported every signed-request vector as
`signing_transport_unavailable` — correct as a fail-closed stop-gap (#2958), but it means no
A2A agent's verifier is ever graded. This wires the dispatch the stop-gap stood in for.

The request is not framed here. `ClientFactory` resolves the agent card and builds the call;
the request is captured at the SDK's own `fetchImpl` seam and those exact bytes are signed,
so the endpoint, the JSON-RPC method name, the `a2a-version` header and the proto-JSON
encoding are all the official client's decisions.

Fail-closed behaviour is preserved rather than replaced: `resolveVectorTransport` still
returns no framing for A2A, and the availability decision moved to the async dispatcher.
An agent whose card does not resolve to a JSONRPC interface keeps the existing
`signing_transport_unavailable` reporting and its guardrails.
