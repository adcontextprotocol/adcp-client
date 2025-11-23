[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createRetryHandler

# Function: createRetryHandler()

> **createRetryHandler**(`responses`, `defaultResponse`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:119](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/handlers/types.ts#L119)

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
