---
'@adcp/sdk': patch
---

fix(unwrapper): prefer DataPart artifact over top-level JSON-RPC error

Sibling of #1575 / #1577 at the unwrap layer. When a non-conformant seller
surfaces both a top-level JSON-RPC `error` AND a terminal-state Task with a
structured DataPart artifact, the artifact is canonical per AdCP
transport-errors §A2A Binding — `unwrapA2AResponse` now defers to the
artifact-extraction path instead of short-circuiting on the transport-level
error. Mirrors the protocol-layer guard added in #1577 so direct callers
(storyboard fixtures, cached responses, webhook normalize paths) inherit
the same defensive behavior.

Top-level JSON-RPC errors without an accompanying terminal-Task artifact
continue to flow through the `errors[]` short-circuit.
