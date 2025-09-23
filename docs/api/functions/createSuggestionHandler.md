[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createSuggestionHandler

# Function: createSuggestionHandler()

> **createSuggestionHandler**(`suggestionIndex`, `fallbackHandler`): [`InputHandler`](../type-aliases/InputHandler.md)

Defined in: [src/lib/handlers/types.ts:159](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/handlers/types.ts#L159)

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
