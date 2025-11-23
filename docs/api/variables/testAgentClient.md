[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / testAgentClient

# Variable: testAgentClient

> `const` **testAgentClient**: [`ADCPMultiAgentClient`](../classes/ADCPMultiAgentClient.md)

Defined in: [src/lib/testing/test-helpers.ts:201](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/testing/test-helpers.ts#L201)

Multi-agent client with both test agents configured.
Useful for testing multi-agent patterns and protocol comparisons.

## Example

```typescript
import { testAgentClient } from '@adcp/client/testing';

// Access individual agents
const mcpAgent = testAgentClient.agent('test-agent-mcp');
const a2aAgent = testAgentClient.agent('test-agent-a2a');

// Or use agent collection for parallel operations
const results = await testAgentClient.allAgents().getProducts({
  brief: 'Premium coffee brands',
  promoted_offering: 'Artisan coffee'
});
```

## Remarks

This client is rate-limited and intended for testing/examples only.
DO NOT use in production applications.
