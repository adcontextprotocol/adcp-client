[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createValidatedHandler

# Function: createValidatedHandler()

> **createValidatedHandler**(`value`, `fallbackHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:185](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/handlers/types.ts#L185)

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
