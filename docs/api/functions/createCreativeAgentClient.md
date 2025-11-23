[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createCreativeAgentClient

# Function: createCreativeAgentClient()

> **createCreativeAgentClient**(`config`): [`CreativeAgentClient`](../classes/CreativeAgentClient.md)

Defined in: [src/lib/core/CreativeAgentClient.ts:196](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L196)

Factory function to create a creative agent client

## Parameters

### config

[`CreativeAgentClientConfig`](../interfaces/CreativeAgentClientConfig.md)

Creative agent configuration

## Returns

[`CreativeAgentClient`](../classes/CreativeAgentClient.md)

Configured CreativeAgentClient instance

## Example

```typescript
const creativeAgent = createCreativeAgentClient({
  agentUrl: 'https://creative.adcontextprotocol.org/mcp'
});
```
