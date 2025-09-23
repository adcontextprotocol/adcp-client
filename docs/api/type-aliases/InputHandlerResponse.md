[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / InputHandlerResponse

# Type Alias: InputHandlerResponse

> **InputHandlerResponse** = `any` \| `Promise`\<`any`\> \| \{ `defer`: `true`; `token`: `string`; \} \| \{ `abort`: `true`; `reason?`: `string`; \} \| `never`

Defined in: [src/lib/core/ConversationTypes.ts:55](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L55)

Different types of responses an input handler can provide
