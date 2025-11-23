[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / InputHandlerResponse

# Type Alias: InputHandlerResponse

> **InputHandlerResponse** = `any` \| `Promise`\<`any`\> \| \{ `defer`: `true`; `token`: `string`; \} \| \{ `abort`: `true`; `reason?`: `string`; \} \| `never`

Defined in: [src/lib/core/ConversationTypes.ts:55](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L55)

Different types of responses an input handler can provide
