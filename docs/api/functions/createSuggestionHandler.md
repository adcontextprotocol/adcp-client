[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createSuggestionHandler

# Function: createSuggestionHandler()

> **createSuggestionHandler**(`suggestionIndex`, `fallbackHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:152](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/handlers/types.ts#L152)

Create a suggestion-based handler that uses agent suggestions when available

## Parameters

### suggestionIndex

`number` = `0`

Index of suggestion to use (0 = first, -1 = last)

### fallbackHandler

[`InputHandler`](../type-aliases/InputHandler.md) = `deferAllHandler`

Handler to use if no suggestions available

## Returns

[`InputHandler`](../type-aliases/InputHandler.md)

## Example

```typescript
const handler = createSuggestionHandler(0, deferAllHandler); // Use first suggestion
```
