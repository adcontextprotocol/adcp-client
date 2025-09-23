[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createValidatedHandler

# Function: createValidatedHandler()

> **createValidatedHandler**(`value`, `fallbackHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:185](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/handlers/types.ts#L185)

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
