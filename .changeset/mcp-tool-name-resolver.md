---
"@adcp/client": minor
---

Add `mcpToolNameResolver` export on `@adcp/client/server` — a default `resolveOperation` for MCP agents wiring RFC 9421 signature auth. Parses the buffered JSON-RPC body on `req.rawBody` and returns `params.name` when `method === 'tools/call'`; returns `undefined` otherwise so the downstream handler produces a precise error instead of the pre-check rejecting every unsigned call.

Use directly as `resolveOperation` on `verifySignatureAsAuthenticator`, `requireSignatureWhenPresent`, or `requireAuthenticatedOrSigned` instead of hand-rolling the same JSON-RPC parser in every seller agent.
