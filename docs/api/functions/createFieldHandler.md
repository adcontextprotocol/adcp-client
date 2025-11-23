[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createFieldHandler

# Function: createFieldHandler()

> **createFieldHandler**(`fieldMap`, `defaultResponse?`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:43](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/handlers/types.ts#L43)

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
