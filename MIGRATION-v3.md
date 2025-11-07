# Migration Guide: v2.x → v3.0

**Breaking Changes**: Deprecated APIs removed, simplified to one canonical client.

---

## Summary of Changes

### Removed (Breaking Changes)

- ❌ `AdCPClient` class (lowercase 'd') - **DELETED**
- ❌ `createAdCPClient()` function - **DELETED**
- ❌ `createAdCPClientFromEnv()` function - **DELETED**
- ❌ `createADCPClient()` function - **DELETED** (from main export)
- ❌ `createADCPMultiAgentClient()` function - **DELETED** (from main export)

### Moved to `/advanced`

- 🔒 `ADCPClient` - Now at `@adcp/client/advanced`
- 🔒 `AgentClient` - Now at `@adcp/client/advanced`
- 🔒 `createADCPClient()` - Now at `@adcp/client/advanced`
- 🔒 Protocol clients (`createA2AClient`, `createMCPClient`) - Now at `@adcp/client/advanced`

### Canonical API (v3.0)

- ✅ `ADCPMultiAgentClient` - **The one true client**
- ✅ Factory methods: `.simple()`, `.fromEnv()`, `.fromFile()`, `.fromConfig()`

---

## Migration Patterns

### Pattern 1: Using `AdCPClient` (deprecated lowercase 'd')

**Before (v2.x)**:
```typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([
  { id: 'agent-1', agent_uri: 'https://agent.com', protocol: 'a2a' }
]);

const agent = client.agent('agent-1');
const result = await agent.getProducts({ brief: '...' });
```

**After (v3.0)**:
```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

const client = new ADCPMultiAgentClient([
  { id: 'agent-1', agent_uri: 'https://agent.com', protocol: 'a2a' }
]);

const agent = client.agent('agent-1');
const result = await agent.getProducts({ brief: '...' });
```

**Change**: Just rename `AdCPClient` → `ADCPMultiAgentClient` (capitalize the 'D')

---

### Pattern 2: Using `createAdCPClient()` or `createAdCPClientFromEnv()`

**Before (v2.x)**:
```typescript
import { createAdCPClient, createAdCPClientFromEnv } from '@adcp/client';

// Option 1
const client = createAdCPClient([agentConfig]);

// Option 2
const client = createAdCPClientFromEnv();
```

**After (v3.0)**:
```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

// Option 1: Use constructor
const client = new ADCPMultiAgentClient([agentConfig]);

// Option 2: Use factory method
const client = ADCPMultiAgentClient.fromEnv();
```

**Change**: Use constructor or static factory methods instead of standalone functions

---

### Pattern 3: Using single-agent `ADCPClient`

**Before (v2.x)**:
```typescript
import { ADCPClient } from '@adcp/client';

const client = new ADCPClient(agentConfig); // Single agent, no array
const result = await client.getProducts({ brief: '...' });
```

**After (v3.0) - Option A: Use ADCPClient with one agent (recommended)**:
```typescript
import { ADCPClient } from '@adcp/client';

const client = new ADCPClient([agentConfig]); // Array with one agent
const agent = client.agent('agent-id');
const result = await agent.getProducts({ brief: '...' });
```

**After (v3.0) - Option B: Import from `/advanced` (if you really need single-agent API)**:
```typescript
import { SingleAgentClient } from '@adcp/client/advanced';

const client = new SingleAgentClient(agentConfig); // Single agent, no array
const result = await client.getProducts({ brief: '...' });
```

**Recommendation**: Use Option A (ADCPClient) for consistency and future-proofing.

---

### Pattern 4: Using `createADCPMultiAgentClient()` helper

**Before (v2.x)**:
```typescript
import { createADCPMultiAgentClient } from '@adcp/client';

const client = createADCPMultiAgentClient([agent1, agent2]);
```

**After (v3.0)**:
```typescript
import { ADCPClient } from '@adcp/client';

const client = new ADCPClient([agent1, agent2]);
```

**Change**: Use ADCPClient constructor directly

---

### Pattern 5: Testing with old API (`.callTool`, `.callToolOnAgents`)

**Before (v2.x)** - Legacy Agent API:
```typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([agent1, agent2]);

// Old API returned {success, data, agent, responseTimeMs}
const results = await client.callToolOnAgents(
  ['agent1', 'agent2'],
  'get_products',
  { brief: '...' }
);

results.forEach(result => {
  if (result.success) {
    console.log(result.data);
  }
});
```

**After (v3.0)** - New conversation-aware API:
```typescript
import { ADCPClient } from '@adcp/client';

const client = new ADCPClient([agent1, agent2]);

// New API returns TaskResult[] with {status, data, agent}
const agentCollection = client.agents(['agent1', 'agent2']);
const results = await agentCollection.getProducts({ brief: '...' });

results.forEach(result => {
  if (result.status === 'completed') {
    console.log(result.data);
  }
});
```

**Key differences**:
- Old: `result.success` → New: `result.status === 'completed'`
- Old: `result.data` → New: `result.data` (same)
- Old: `result.error` (string) → New: `result.error` (object with `.message`)
- Old: No conversation support → New: Full conversation support with `needs_input` status

---

## New Features in v3.0

### Factory Methods

```typescript
import { ADCPClient } from '@adcp/client';

// 1. Simplest possible (for demos)
const client = ADCPClient.simple('https://agent.com');

// 2. From environment variables
const client = ADCPClient.fromEnv();

// 3. From config file
const client = ADCPClient.fromFile('./agents.json');

// 4. From config object
const client = ADCPClient.fromConfig({
  // ... config options
});

// 5. Constructor (explicit)
const client = new ADCPClient([agentConfig]);
```

### Conversation Support

```typescript
const agent = client.agent('agent-1');

// Agent might need clarification
const result = await agent.getProducts({ brief: 'Coffee brands' });

if (result.status === 'needs_input') {
  console.log('Agent needs:', result.needs_input?.message);

  // Continue the conversation
  const refined = await agent.continueConversation('Only premium brands');

  if (refined.status === 'completed') {
    console.log('Got products:', refined.data.products);
  }
}
```

### Webhook/Async Support

```typescript
const agent = client.agent('agent-1');

const result = await agent.syncCreatives(
  { creatives: largeList },
  null, // No clarification handler
  {
    contextId: 'op_123',
    webhookUrl: 'https://myapp.com/webhook/sync_creatives/op_123'
  }
);

if (result.status === 'submitted') {
  console.log('Agent will send webhook to:', result.submitted?.webhookUrl);
}
```

---

## Advanced Usage

### When to use `/advanced` exports

Import from `@adcp/client/advanced` if you need:

1. **Direct protocol clients** for low-level control:
   ```typescript
   import { createA2AClient, createMCPClient } from '@adcp/client/advanced';

   const a2aClient = createA2AClient('https://agent.com', 'token');
   const result = await a2aClient.callTool('get_products', 'brief', 'offering');
   ```

2. **Single-agent ADCPClient** for integration with existing systems:
   ```typescript
   import { ADCPClient } from '@adcp/client/advanced';

   const client = new ADCPClient(agentConfig); // No array
   const result = await client.getProducts({ brief: '...' });
   ```

3. **AgentClient** for automatic context tracking:
   ```typescript
   import { AgentClient } from '@adcp/client/advanced';

   const client = new AgentClient(agentConfig);
   // Context automatically tracked across all calls
   ```

### Most developers don't need `/advanced`

The main export provides everything you need:
```typescript
import { ADCPMultiAgentClient } from '@adcp/client';
```

---

## Testing Migration

### Update Test Imports

**Before (v2.x)**:
```javascript
const { AdCPClient, createAdCPClient } = require('@adcp/client');

const client = new AdCPClient();
assert.strictEqual(client.getAgents().length, 0);
```

**After (v3.0)**:
```javascript
const { ADCPMultiAgentClient } = require('@adcp/client');

const client = new ADCPMultiAgentClient();
assert.strictEqual(client.getAgentConfigs().length, 0);
```

**Changes**:
- `AdCPClient` → `ADCPMultiAgentClient`
- `client.getAgents()` → `client.getAgentConfigs()`

---

## API Method Mappings

### Client Methods

| v2.x (AdCPClient) | v3.0 (ADCPMultiAgentClient) |
|-------------------|----------------------------|
| `new AdCPClient(agents)` | `new ADCPMultiAgentClient(agents)` |
| `client.getAgents()` | `client.getAgentConfigs()` |
| `client.addAgent(agent)` | `client.addAgent(agent)` ✅ (same) |
| `client.agent(id)` | `client.agent(id)` ✅ (same) |
| `client.agents(ids)` | `client.agents(ids)` ✅ (same) |
| `client.allAgents()` | `client.allAgents()` ✅ (same) |
| `client.agentCount` | `client.agentCount` ✅ (same) |
| `client.agentIds` | `client.getAgentIds()` |
| `client.callTool(...)` | Use `.agent(id).getProducts(...)` |
| `client.callToolOnAgents(...)` | Use `.agents(ids).getProducts(...)` |

### Result Formats

| v2.x (Legacy) | v3.0 (Conversation-Aware) |
|---------------|---------------------------|
| `{success: true, data, agent, responseTimeMs}` | `{status: 'completed', data, agent}` |
| `{success: false, error, agent}` | `{status: 'failed', error: {message}, agent}` |
| N/A | `{status: 'needs_input', needs_input, agent}` |
| N/A | `{status: 'submitted', submitted: {webhookUrl}, agent}` |

---

## FAQ

### Q: Why was `AdCPClient` removed?

**A**: It was a deprecated wrapper around `ADCPMultiAgentClient` that added confusion (looked like a typo vs `ADCPClient`). We're standardizing on one clear API.

### Q: I only have one agent - do I really need `ADCPMultiAgentClient`?

**A**: Yes! Even with one agent, use `ADCPMultiAgentClient`. Benefits:
- Future-proof (easy to add agents later)
- Consistent API across all use cases
- No refactoring needed when scaling
- Full conversation and webhook support

### Q: Can I still use the single-agent API?

**A**: Yes, import from `/advanced`:
```typescript
import { ADCPClient } from '@adcp/client/advanced';
```

But we recommend using `ADCPMultiAgentClient` for all cases.

### Q: What about `createADCPClient()` helper functions?

**A**: Removed from main export. Use:
- Constructor: `new ADCPMultiAgentClient([...])`
- Or factory methods: `.simple()`, `.fromEnv()`, etc.

Advanced users can still import helpers from `/advanced`.

### Q: Do I need to change my test code?

**A**: Yes, update:
1. Import: `AdCPClient` → `ADCPMultiAgentClient`
2. Methods: `getAgents()` → `getAgentConfigs()`
3. Result format: `result.success` → `result.status === 'completed'`

### Q: Will my v2.x code break immediately?

**A**: Yes, if you used:
- `AdCPClient` (lowercase 'd')
- `createAdCPClient()` or `createAdCPClientFromEnv()`
- Helper functions like `createADCPMultiAgentClient()`

Follow this guide to migrate.

---

## Quick Migration Checklist

- [ ] Find all `AdCPClient` imports → Change to `ADCPMultiAgentClient`
- [ ] Find all `createAdCPClient()` calls → Use constructor or `.fromEnv()`
- [ ] Find all `createAdCPClientFromEnv()` → Use `ADCPMultiAgentClient.fromEnv()`
- [ ] Find all `client.getAgents()` → Change to `client.getAgentConfigs()`
- [ ] Find all `result.success` checks → Change to `result.status === 'completed'`
- [ ] Find all `.callTool()` or `.callToolOnAgents()` → Use typed methods like `.getProducts()`
- [ ] Run tests to verify everything works
- [ ] Update examples/docs to show new patterns

---

## Support

If you encounter issues during migration:

1. Check this guide for your specific use case
2. Review the [examples/](./examples/) directory for updated patterns
3. Open an issue: https://github.com/adcontextprotocol/adcp-client/issues

---

**Last updated**: 2025-11-07 (v3.0 release)
