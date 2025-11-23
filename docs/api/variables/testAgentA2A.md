[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / testAgentA2A

# Variable: testAgentA2A

> `const` **testAgentA2A**: [`AgentClient`](../classes/AgentClient.md)

Defined in: [src/lib/testing/test-helpers.ts:121](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/testing/test-helpers.ts#L121)

Pre-configured test agent client using A2A protocol.
Identical functionality to testAgent but uses A2A instead of MCP.

## Example

```typescript
import { testAgentA2A } from '@adcp/client/testing';

const result = await testAgentA2A.getProducts({
  brief: 'Sustainable fashion brands',
  promoted_offering: 'Eco-friendly clothing'
});
```

## Remarks

This agent is rate-limited and intended for testing/examples only.
The auth token is public and may be rotated without notice.
DO NOT use in production applications.
