# Migration Guide: v2.x → v3.0

**Breaking Changes**: Simplified API with unified client architecture and atomic response types

---

## Summary of Changes

### 1. Naming Simplification

The client API has been unified under a single name:
- **Primary export**: `AdCPClient` (formerly `ADCPMultiAgentClient`)
- **Deprecated**: `ADCPMultiAgentClient` still works but will be removed in v4.0
- **Removed**: Internal class names are no longer exposed

### 2. Response Type Changes (Breaking)

Task responses now use discriminated unions with atomic semantics (success XOR errors).

**What this means**: Responses can contain EITHER success data OR errors, never both.

**Before (v2.x)**:
```typescript
interface CreateMediaBuyResponse {
  media_buy_id?: string;      // Optional
  packages?: Package[];        // Optional
  errors?: Error[];            // Optional
}

// Code could check both simultaneously
if (response.media_buy_id) {
  // Success
} else if (response.errors) {
  // Error
}
```

**After (v3.0)**:
```typescript
type CreateMediaBuyResponse =
  | { media_buy_id: string; packages: Package[] }  // Success branch (required fields)
  | { errors: [Error, ...Error[]] };                // Error branch (non-empty array)

// Use type guards to determine which branch
if ('media_buy_id' in response) {
  // Success branch - media_buy_id is guaranteed to exist
  console.log(response.media_buy_id);
} else {
  // Error branch - errors is guaranteed to exist
  console.error(response.errors);
}
```

**Migration**: Replace property checks (`if (response.property)`) with type guards (`if ('property' in response)`).

---

## Migration Patterns

### Pattern 1: Renaming `ADCPMultiAgentClient` (most common)

**Before (v2.x)**:
```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

const client = new ADCPMultiAgentClient([
  { id: 'agent-1', agent_uri: 'https://agent.com', protocol: 'a2a' }
]);

const agent = client.agent('agent-1');
const result = await agent.getProducts({ brief: '...' });
```

**After (v3.0)**:
```typescript
import { AdCPClient } from '@adcp/client';  // ← Changed import name

const client = new AdCPClient([
  { id: 'agent-1', agent_uri: 'https://agent.com', protocol: 'a2a' }
]);

const agent = client.agent('agent-1');
const result = await agent.getProducts({ brief: '...' });
```

**Change**: Import and use `AdCPClient` instead of `ADCPMultiAgentClient`.

---

### Pattern 2: Using factory functions

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
import { AdCPClient } from '@adcp/client';

// Option 1: Use constructor
const client = new AdCPClient([agentConfig]);

// Option 2: Use static factory method
const client = AdCPClient.fromEnv();
```

**Change**: Use constructor or static factory methods instead of standalone functions.

---

### Pattern 3: Handling responses with discriminated unions

**Before (v2.x)**:
```typescript
const result = await agent.createMediaBuy(params);

// Check optional properties
if (result.data.media_buy_id) {
  console.log('Created:', result.data.media_buy_id);
}

if (result.data.errors && result.data.errors.length > 0) {
  console.error('Errors:', result.data.errors);
}
```

**After (v3.0)**:
```typescript
const result = await agent.createMediaBuy(params);

// Use type guards to check which branch
if ('media_buy_id' in result.data) {
  // Success branch - media_buy_id is guaranteed present
  console.log('Created:', result.data.media_buy_id);
  console.log('Packages:', result.data.packages);  // Also guaranteed present
} else {
  // Error branch - errors is guaranteed present
  console.error('Errors:', result.data.errors);
}
```

**Change**: Replace property existence checks with `'property' in response` type guards.

---

### Pattern 4: Method name changes

**Before (v2.x)**:
```typescript
const agents = client.getAgents(); // Returns AgentConfig[]
```

**After (v3.0)**:
```typescript
const agents = client.getAgentConfigs(); // Returns AgentConfig[]
```

**Change**: `getAgents()` → `getAgentConfigs()`

---

## Breaking Changes Checklist

### Naming Changes
- [ ] Replace `ADCPMultiAgentClient` with `AdCPClient` in imports
- [ ] Replace `createAdCPClient()` with `new AdCPClient()`
- [ ] Replace `createAdCPClientFromEnv()` with `AdCPClient.fromEnv()`
- [ ] Replace `client.getAgents()` with `client.getAgentConfigs()`

### Response Handling Changes (All Task Methods)
- [ ] Replace `if (response.media_buy_id)` with `if ('media_buy_id' in response)`
- [ ] Replace `if (response.errors)` with `if ('errors' in response)` or use else branch
- [ ] Remove code that checks for both success and error fields simultaneously
- [ ] Update TypeScript types to handle discriminated union branches

**Affected methods**: All task methods return discriminated union types:
- `getProducts()` → `GetProductsResponse`
- `listCreativeFormats()` → `ListCreativeFormatsResponse`
- `createMediaBuy()` → `CreateMediaBuyResponse`
- `updateMediaBuy()` → `UpdateMediaBuyResponse`
- `syncCreatives()` → `SyncCreativesResponse`
- `listCreatives()` → `ListCreativesResponse`
- `getMediaBuyDelivery()` → `GetMediaBuyDeliveryResponse`
- `listAuthorizedProperties()` → `ListAuthorizedPropertiesResponse`
- `providePerformanceFeedback()` → `ProvidePerformanceFeedbackResponse`
- `getSignals()` → `GetSignalsResponse`
- `activateSignal()` → `ActivateSignalResponse`

---

## Why These Changes?

### 1. Simpler Naming
`AdCPClient` is shorter and clearer than `ADCPMultiAgentClient`. It handles both single-agent and multi-agent use cases seamlessly.

### 2. Atomic Response Semantics
Discriminated unions enforce that responses contain EITHER success data OR errors, never both. This matches the AdCP v2.2 schema specification and prevents ambiguous states.

### 3. Type Safety
TypeScript can now properly narrow types based on which branch you're in, eliminating the need for optional property checks and reducing runtime errors.

---

## Gradual Migration (v3.x Compatibility Period)

You can migrate gradually during the v3.x series:

**Step 1**: Update response handling to use type guards (required immediately)
```typescript
// Change from:
if (response.media_buy_id) { ... }
// To:
if ('media_buy_id' in response) { ... }
```

**Step 2**: Update import names (recommended, but `ADCPMultiAgentClient` still works)
```typescript
// Change from:
import { ADCPMultiAgentClient } from '@adcp/client';
// To:
import { AdCPClient } from '@adcp/client';
```

**In v4.0**: The `ADCPMultiAgentClient` alias will be removed. You must use `AdCPClient`.

---

## Need Help?

If you encounter issues during migration:

1. Check the [API documentation](./docs/api/classes/AdCPClient-1.md)
2. Review the [webhook examples](./test/webhook-url-macros.test.js) for updated patterns
3. Open an issue at https://github.com/adcontextprotocol/adcp-client/issues
