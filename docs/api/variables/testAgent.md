[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / testAgent

# Variable: testAgent

> `const` **testAgent**: [`AgentClient`](../classes/AgentClient.md)

Defined in: [src/lib/testing/test-helpers.ts:100](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/testing/test-helpers.ts#L100)

Pre-configured test agent client using MCP protocol.
Ready to use for examples, documentation, and quick testing.

## Examples

```typescript
import { testAgent } from '@adcp/client/testing';

// Simple getProducts call
const result = await testAgent.getProducts({
  brief: 'Coffee subscription service for busy professionals',
  promoted_offering: 'Premium monthly coffee deliveries'
});

if (result.success) {
  console.log(`Found ${result.data.products.length} products`);
}
```

```typescript
// With AI test orchestration (natural language instructions)
const result = await testAgent.createMediaBuy({
  brief: 'Test campaign',
  promoted_offering: 'Wait 10 seconds before responding',
  products: ['prod_123'],
  budget: 10000
});
```

## Remarks

This agent is rate-limited and intended for testing/examples only.
The auth token is public and may be rotated without notice.
DO NOT use in production applications.
