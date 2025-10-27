---
"@adcp/client": patch
---

Fixed A2A protocol discovery endpoint and Accept headers

- Changed discovery endpoint from incorrect `/.well-known/a2a-server` to correct `/.well-known/agent-card.json` per A2A spec
- Updated Accept header from `application/json` to `application/json, */*` for better compatibility with various server implementations
- Updated protocol detection test to correctly expect A2A detection for test-agent.adcontextprotocol.org
