---
'@adcp/sdk': minor
---

feat(server): `ConformanceClient` — outbound-WebSocket Socket Mode primitive that lets adopter dev/staging MCP servers connect to a remote AdCP runner (today, Addie at agenticadvertising.org) without public DNS or inbound exposure. Three-line integration: `new ConformanceClient({ url, token, server }).start()`. Reverse-RPC at the TCP level only — MCP semantics unchanged. Dev/staging only by design (per AdCP #3986 deployment-scoped controller rule). Exposed from `@adcp/sdk/server`.
