---
"@adcp/client": minor
---

Add CLI tool and MCP endpoint auto-discovery

- Add command-line tool (`bin/adcp.js`) for testing AdCP agents
- Add automatic MCP endpoint discovery (tests provided path, then tries adding /mcp)
- Add `getAgentInfo()` method for discovering agent capabilities
- CLI supports tool discovery, execution, authentication, and async webhook handling
