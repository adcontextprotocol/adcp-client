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
- 🔒 Single-agent API moved to `@adcp/client/advanced` as `SingleAgentClient`

### Simple Summary

**If you were using `ADCPMultiAgentClient`**: Just rename it to `AdCPClient` (both work in v3, but `AdCPClient` is preferred)

**If you were using `AdCPClient` (lowercase 'd')**: Change to `AdCPClient` and it works the same way

**If you were using the old single-agent `AdCPClient`**: Either use the new `AdCPClient` with an array of one agent, or import `SingleAgentClient` from `/advanced`

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

**Change**: Capitalize the 'D': `AdCPClient` → `AdCPClient`

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

**After (v3.0) - Option A: Use new AdCPClient with array (recommended)**:
\`\`\`typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([agentConfig]); // Array with one agent
const agent = client.agent(agentConfig.id);
const result = await agent.getProducts({ brief: '...' });
\`\`\`

**After (v3.0) - Option B: Use SingleAgentClient from \`/advanced\`**:
\`\`\`typescript
import { SingleAgentClient } from '@adcp/client/advanced';

const client = new SingleAgentClient(agentConfig); // Single agent, no array
const result = await client.getProducts({ brief: '...' });
\`\`\`

**Recommendation**: Use Option A (new \`AdCPClient\`) for consistency. The single-agent API is available in \`/advanced\` but is not recommended for new code.

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

- [ ] Replace \`AdCPClient\` with \`AdCPClient\` (capitalize the 'D')
- [ ] Replace \`ADCPMultiAgentClient\` with \`AdCPClient\` (shorter name)
- [ ] Replace \`createAdCPClient()\` with \`new AdCPClient()\`
- [ ] Replace \`createAdCPClientFromEnv()\` with \`AdCPClient.fromEnv()\`
- [ ] Replace \`client.getAgents()\` with \`client.getAgentConfigs()\`
- [ ] If using single-agent API, wrap config in array or import from \`/advanced\`

---

## Why These Changes?

1. **Simpler naming**: \`AdCPClient\` is shorter and clearer than \`ADCPMultiAgentClient\`
2. **Consistent casing**: Removed the confusing lowercase 'd' variant (\`AdCPClient\`)
3. **Cleaner exports**: Advanced/low-level APIs moved to \`/advanced\` path
4. **Future-proof**: Multi-agent is the default, single-agent is the special case
