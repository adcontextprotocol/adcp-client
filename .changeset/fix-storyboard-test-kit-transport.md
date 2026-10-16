---
'@adcp/sdk': patch
---

Run successful test-kit-authenticated storyboard steps through the configured official MCP or A2A client. Preserve HTTP development transport settings and routing headers while isolating step credentials from the suite's authentication.

Credential-shaped custom headers and the suite's request-signing identity remain excluded from isolated steps. Use non-credential routing header names such as `X-AdCP-Tenant`.
