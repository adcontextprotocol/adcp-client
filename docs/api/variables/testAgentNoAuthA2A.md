[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / testAgentNoAuthA2A

# Variable: testAgentNoAuthA2A

> `const` **testAgentNoAuthA2A**: [`AgentClient`](../classes/AgentClient.md)

Defined in: [src/lib/testing/test-helpers.ts:174](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/testing/test-helpers.ts#L174)

Pre-configured test agent client WITHOUT authentication (A2A protocol).
Demonstrates what happens when calling authenticated endpoints without auth.
Useful for testing error handling and showing auth vs no-auth differences.

## Example

```typescript
import { testAgentNoAuthA2A } from '@adcp/client/testing';

// Compare authenticated vs unauthenticated
import { testAgentA2A } from '@adcp/client/testing';

// This works (has auth)
const authResult = await testAgentA2A.getProducts({ brief: 'Test' });

// This fails (no auth)
const noAuthResult = await testAgentNoAuthA2A.getProducts({ brief: 'Test' });
```

## Remarks

This agent intentionally does NOT include authentication.
Use it to demonstrate authentication requirements and error handling.
