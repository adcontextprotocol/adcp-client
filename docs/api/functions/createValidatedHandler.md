[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createValidatedHandler

# Function: createValidatedHandler()

> **createValidatedHandler**(`value`, `fallbackHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:178](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/handlers/types.ts#L178)

Create a validation-aware handler that respects input validation rules

## Parameters

### value

`any`

Value to return

### fallbackHandler

[`InputHandler`](../type-aliases/InputHandler.md) = `deferAllHandler`

Handler to use if value doesn't pass validation

## Returns

[`InputHandler`](../type-aliases/InputHandler.md)
