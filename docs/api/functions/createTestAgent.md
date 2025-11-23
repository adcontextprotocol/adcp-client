[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createTestAgent

# Function: createTestAgent()

> **createTestAgent**(`overrides?`): [`AgentConfig`](../interfaces/AgentConfig.md)

Defined in: [src/lib/testing/test-helpers.ts:228](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/testing/test-helpers.ts#L228)

Create a custom test agent configuration.
Useful when you need to modify the default test agent setup.

## Parameters

### overrides?

`Partial`\<[`AgentConfig`](../interfaces/AgentConfig.md)\>

Partial agent config to override defaults

## Returns

[`AgentConfig`](../interfaces/AgentConfig.md)

Complete agent configuration

## Examples

```typescript
import { createTestAgent, AdCPClient } from '@adcp/client/testing';

// Use default test agent with custom ID
const config = createTestAgent({ id: 'my-test-agent' });
const client = new AdCPClient([config]);
```

```typescript
// Use A2A protocol instead of MCP
const config = createTestAgent({
  protocol: 'a2a',
  agent_uri: 'https://test-agent.adcontextprotocol.org'
});
```
