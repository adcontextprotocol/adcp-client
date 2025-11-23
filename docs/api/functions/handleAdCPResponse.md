[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / handleAdCPResponse

# Function: handleAdCPResponse()

> **handleAdCPResponse**(`response`, `expectedSchema`, `agentName`): `Promise`\<\{ `success`: `boolean`; `data?`: `any`; `error?`: `string`; `warnings?`: `string`[]; \}\>

Defined in: [src/lib/validation/index.ts:128](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/validation/index.ts#L128)

Handle AdCP response with comprehensive error checking

## Parameters

### response

`Response`

### expectedSchema

`string`

### agentName

`string`

## Returns

`Promise`\<\{ `success`: `boolean`; `data?`: `any`; `error?`: `string`; `warnings?`: `string`[]; \}\>
