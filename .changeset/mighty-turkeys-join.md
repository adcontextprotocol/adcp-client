---
'@adcp/client': minor
---

Added test helpers for easy testing and self-documenting examples. New exports include `testAgent` (pre-configured MCP test agent), `testAgentA2A` (pre-configured A2A test agent), `testAgentClient` (multi-agent client with both protocols), `createTestAgent()` helper function, `creativeAgent` (pre-configured MCP creative agent), and `creativeAgentA2A` (pre-configured A2A creative agent). Test helpers are available via `@adcp/client/testing` subpath export and provide instant access to AdCP's public test agent and official creative agent with no configuration required.

Also added built-in CLI aliases (`test`, `test-a2a`, `creative`, `creative-a2a`) for zero-config command-line access to test and creative agents.
