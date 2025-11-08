# Migration Guide: v2.x → v3.0

**Breaking Changes**: Simplified API with one canonical client name: `AdCPClient`

---

## Summary of Changes

### What Changed

The main change is **naming simplification**:
- ✅ `AdCPClient` is now the primary export (renamed from `ADCPMultiAgentClient`)
- ⚠️ `ADCPMultiAgentClient` still works as a deprecated alias (will be removed in v4.0)
- ❌ `AdCPClient` (lowercase 'd') has been removed
- ❌ Factory functions like `createAdCPClient()` have been removed

### Simple Summary

**If you were using `ADCPMultiAgentClient`**: Just rename it to `AdCPClient` (both work in v3, but `AdCPClient` is preferred)

**If you were using `AdCPClient` (lowercase 'd')**: Change to uppercase 'C' and 'P': `AdCPClient` → `AdCPClient`

**If you were using the old single-agent `AdCPClient`**: Use the new `AdCPClient` with an array of one agent, then call `.agent(id)` to get a single-agent client with conversation context

---

## Migration Patterns

### Pattern 1: Using `ADCPMultiAgentClient` (most common)

**Before (v2.x)**:
\`\`\`typescript
import { ADCPMultiAgentClient } from '@adcp/client';

const client = new ADCPMultiAgentClient([
  { id: 'agent-1', agent_uri: 'https://agent.com', protocol: 'a2a' }
]);

const agent = client.agent('agent-1');
const result = await agent.getProducts({ brief: '...' });
\`\`\`

**After (v3.0)**:
\`\`\`typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([
  { id: 'agent-1', agent_uri: 'https://agent.com', protocol: 'a2a' }
]);

const agent = client.agent('agent-1');
const result = await agent.getProducts({ brief: '...' });
\`\`\`

**Change**: Just rename `ADCPMultiAgentClient` → `AdCPClient`

---

### Pattern 2: Using `AdCPClient` (lowercase 'd' - deprecated)

**Before (v2.x)**:
\`\`\`typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([
  { id: 'agent-1', agent_uri: 'https://agent.com', protocol: 'a2a' }
]);

const agent = client.agent('agent-1');
const result = await agent.getProducts({ brief: '...' });
\`\`\`

**After (v3.0)**:
\`\`\`typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([
  { id: 'agent-1', agent_uri: 'https://agent.com', protocol: 'a2a' }
]);

const agent = client.agent('agent-1');
const result = await agent.getProducts({ brief: '...' });
\`\`\`

**Change**: Change to uppercase 'C' and 'P': `AdCPClient` → `AdCPClient`

---

### Pattern 3: Using factory functions

**Before (v2.x)**:
\`\`\`typescript
import { createAdCPClient, createAdCPClientFromEnv } from '@adcp/client';

// Option 1
const client = createAdCPClient([agentConfig]);

// Option 2
const client = createAdCPClientFromEnv();
\`\`\`

**After (v3.0)**:
\`\`\`typescript
import { AdCPClient } from '@adcp/client';

// Option 1: Use constructor
const client = new AdCPClient([agentConfig]);

// Option 2: Use static factory method
const client = AdCPClient.fromEnv();
\`\`\`

**Change**: Use constructor or static factory methods instead of standalone functions

---

### Pattern 4: Using old single-agent `AdCPClient`

**Before (v2.x)**:
\`\`\`typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient(agentConfig); // Single agent, no array
const result = await client.getProducts({ brief: '...' });
\`\`\`

**After (v3.0)**:
\`\`\`typescript
import { AdCPClient } from '@adcp/client';

// Wrap config in array, then get agent client with conversation context
const client = new AdCPClient([agentConfig]);
const agent = client.agent(agentConfig.id);

// This agent client maintains conversation context automatically!
const result = await agent.getProducts({ brief: '...' });

// You can continue the conversation with context preserved
const refined = await agent.continueConversation('Show only premium options');
\`\`\`

**Key improvement**: The `.agent(id)` method returns a client with automatic conversation context tracking, which the old single-agent API didn't have!

---

### Pattern 5: Method name changes

**Before (v2.x)**:
\`\`\`typescript
const agents = client.getAgents(); // Returns AgentConfig[]
\`\`\`

**After (v3.0)**:
\`\`\`typescript
const agents = client.getAgentConfigs(); // Returns AgentConfig[]
\`\`\`

**Change**: \`getAgents()\` → \`getAgentConfigs()\`

---

## Breaking Changes Checklist

- [ ] Replace \`AdCPClient\` with \`AdCPClient\` (change to uppercase 'C' and 'P')
- [ ] Replace \`ADCPMultiAgentClient\` with \`AdCPClient\` (shorter name)
- [ ] Replace \`createAdCPClient()\` with \`new AdCPClient()\`
- [ ] Replace \`createAdCPClientFromEnv()\` with \`AdCPClient.fromEnv()\`
- [ ] Replace \`client.getAgents()\` with \`client.getAgentConfigs()\`
- [ ] If using single-agent API, wrap config in array and use \`.agent(id)\` to get conversation-aware client

---

## Why These Changes?

1. **Simpler naming**: \`AdCPClient\` is shorter and clearer than \`ADCPMultiAgentClient\`
2. **Consistent casing**: Removed the confusing lowercase 'd' variant (\`AdCPClient\`)
3. **Better conversation support**: The new \`.agent(id)\` method returns a client with automatic conversation context tracking
4. **Unified API**: One client handles both single-agent and multi-agent use cases seamlessly
