[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / combineHandlers

# Function: combineHandlers()

> **combineHandlers**(`handlers`, `defaultHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:228](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/handlers/types.ts#L228)

Combine multiple handlers with fallback logic
Tries each handler in order until one succeeds (doesn't defer or abort)

## Parameters

### handlers

[`InputHandler`](../type-aliases/InputHandler.md)[]

Array of handlers to try in order

### defaultHandler

[`InputHandler`](../type-aliases/InputHandler.md) = `deferAllHandler`

Final fallback handler

## Returns

[`InputHandler`](../type-aliases/InputHandler.md)
