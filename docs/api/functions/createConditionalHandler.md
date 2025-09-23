[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createConditionalHandler

# Function: createConditionalHandler()

> **createConditionalHandler**(`conditions`, `defaultHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:94](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/handlers/types.ts#L94)

Create a conditional handler that applies different logic based on context

## Parameters

### conditions

`object`[]

Array of condition/handler pairs

### defaultHandler

[`InputHandler`](../type-aliases/InputHandler.md) = `deferAllHandler`

Handler to use if no conditions match

## Returns

[`InputHandler`](../type-aliases/InputHandler.md)

## Example

```typescript
const handler = createConditionalHandler([
  {
    condition: (ctx) => ctx.inputRequest.field === 'budget',
    handler: (ctx) => ctx.attempt === 1 ? 100000 : 50000
  },
  {
    condition: (ctx) => ctx.agent.name.includes('Premium'),
    handler: autoApproveHandler
  }
], deferAllHandler);
```
