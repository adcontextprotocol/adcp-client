---
"@adcp/sdk": patch
---

fix(client): widen connectMCPWithFallback retry predicate to cover generic transient errors

Previously the single-retry gate was gated on `instanceof StreamableHTTPError`, which only matched the canonical "Session not found" 400. Network blips, JSON parse errors on half-buffered responses, and mid-handshake proxy disconnects (Cloudflare, Fastly) all surface as generic `Error` or `McpError` and were silently skipped. The predicate is now `!is401Error(error)` — retry on any first-connect failure except auth, where a second attempt is pointless.
