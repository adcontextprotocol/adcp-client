---
"@adcp/client": patch
---

feat: URL canonicalization and agent comparison

**Auto-detect A2A protocol for .well-known/agent-card.json URLs**

When users provide a `.well-known/agent-card.json` URL (e.g., `https://example.com/.well-known/agent-card.json`), the library now correctly detects this as an A2A agent card discovery URL and switches to the A2A protocol.

**Canonical URL resolution**

Added methods to resolve and compare agents by their canonical base URL:

- `getCanonicalUrl()` - Synchronously returns the canonical base URL (computed from configured URL)
- `resolveCanonicalUrl()` - Async method that fetches the agent card (A2A) or discovers endpoint (MCP) to get the authoritative canonical URL
- `isSameAgent(other)` - Compare two agents by canonical URL
- `isSameAgentResolved(other)` - Async comparison that resolves canonical URLs first
- `getResolvedAgent()` - Get agent config with canonical URL resolved

Canonical URL computation:
- For A2A: Uses the `url` field from the agent card, or strips `/.well-known/agent-card.json`
- For MCP: Strips `/mcp` or `/mcp/` suffix from discovered endpoint

This enables comparing agents regardless of how they were configured:
```typescript
// These all resolve to the same canonical URL: https://example.com
agent1.agent_uri = 'https://example.com'
agent2.agent_uri = 'https://example.com/mcp'
agent3.agent_uri = 'https://example.com/.well-known/agent-card.json'

client.agent('agent1').isSameAgent(client.agent('agent2')) // true
```

Fixes #175
