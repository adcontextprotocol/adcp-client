[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / InputHandlerResponse

# Type Alias: InputHandlerResponse

> **InputHandlerResponse** = `any` \| `Promise`\<`any`\> \| \{ `defer`: `true`; `token`: `string`; \} \| \{ `abort`: `true`; `reason?`: `string`; \} \| `never`

Defined in: [src/lib/core/ConversationTypes.ts:55](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L55)

Different types of responses an input handler can provide
