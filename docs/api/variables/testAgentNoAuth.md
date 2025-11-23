[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / testAgentNoAuth

# Variable: testAgentNoAuth

> `const` **testAgentNoAuth**: [`AgentClient`](../classes/AgentClient.md)

Defined in: [src/lib/testing/test-helpers.ts:147](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/testing/test-helpers.ts#L147)

Pre-configured test agent client WITHOUT authentication (MCP protocol).
Demonstrates what happens when calling authenticated endpoints without auth.
Useful for testing error handling and showing auth vs no-auth differences.

## Example

```typescript
import { testAgentNoAuth } from '@adcp/client/testing';

// This will fail with authentication error
try {
  const result = await testAgentNoAuth.getProducts({
    brief: 'Coffee subscription',
    promoted_offering: 'Premium coffee'
  });
} catch (error) {
  console.log('Expected auth error:', error.message);
}
```

## Remarks

This agent intentionally does NOT include authentication.
Use it to demonstrate authentication requirements and error handling.
