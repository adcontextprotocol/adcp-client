---
"@adcp/client": patch
---

fix: auto-detect A2A protocol for .well-known/agent-card.json URLs

When users provide a `.well-known/agent-card.json` URL (e.g., `https://example.com/.well-known/agent-card.json`), the library now correctly detects this as an A2A agent card discovery URL and switches to the A2A protocol.

Previously, if `protocol: 'mcp'` was specified with an agent card URL, the library would try invalid endpoints like `https://example.com/.well-known/agent-card.json/mcp`.

Now the library recognizes that `.well-known/agent-card.json` URLs are A2A discovery URLs and uses the A2A protocol handler, which already knows how to fetch the agent card and extract the canonical URL.

Fixes #175
