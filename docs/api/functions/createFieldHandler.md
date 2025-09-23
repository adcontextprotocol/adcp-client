[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createFieldHandler

# Function: createFieldHandler()

> **createFieldHandler**(`fieldMap`, `defaultResponse?`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:47](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/handlers/types.ts#L47)

Create a field-specific handler that provides different responses based on the field being requested

## Parameters

### fieldMap

[`FieldHandlerConfig`](../interfaces/FieldHandlerConfig.md)

Map of field names to responses or response functions

### defaultResponse?

`any`

Default response for unmapped fields (defaults to defer)

## Returns

[`InputHandler`](../type-aliases/InputHandler.md)

## Example

```typescript
const handler = createFieldHandler({
  budget: 50000,
  targeting: ['US', 'CA'],
  approval: (context) => context.attempt === 1 ? true : false
});
```
