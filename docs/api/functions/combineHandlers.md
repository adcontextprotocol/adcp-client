[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / combineHandlers

# Function: combineHandlers()

> **combineHandlers**(`handlers`, `defaultHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:218](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/handlers/types.ts#L218)

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
