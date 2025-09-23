[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createRetryHandler

# Function: createRetryHandler()

> **createRetryHandler**(`responses`, `defaultResponse`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:126](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/handlers/types.ts#L126)

Create a retry handler that provides different responses based on attempt number

## Parameters

### responses

`any`[]

Array of responses for each attempt (1-indexed)

### defaultResponse

`any` = `deferAllHandler`

Response to use for attempts beyond the array length

## Returns

[`InputHandler`](../type-aliases/InputHandler.md)

## Example

```typescript
const handler = createRetryHandler([
  100000,  // First attempt
  50000,   // Second attempt
  25000    // Third attempt
], deferAllHandler);
```
