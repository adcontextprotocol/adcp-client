---
'@adcp/sdk': patch
---

Harden diagnostic parsing, Markdown escaping, OAuth logging, credential-derived MCP cache identifiers, and structured logger metadata against CodeQL-identified security risks. Logger handlers now receive credential-redacted, non-mutating metadata copies by default; custom handlers that provide equivalent protection can opt out with `redactCredentials: false`.
