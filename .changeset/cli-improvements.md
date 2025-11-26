---
"@adcp/client": patch
---

Improve CLI protocol detection reliability and maintainability

- Add 5-second timeout to protocol detection requests to prevent CLI from hanging on unresponsive servers
- Extract URL normalization logic into helper functions for better code reuse and testing
- Add proper error handling for MCP client.close() operations
- Replace glob pattern in package.json with explicit file list to prevent accidental inclusion of temporary files
- Add comprehensive unit tests for protocol detection helper functions and logic flow
