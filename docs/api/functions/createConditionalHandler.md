[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createConditionalHandler

# Function: createConditionalHandler()

> **createConditionalHandler**(`conditions`, `defaultHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:87](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/handlers/types.ts#L87)

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
