[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / isAdcpSuccess

# Function: isAdcpSuccess()

> **isAdcpSuccess**(`response`, `taskName`): `boolean`

Defined in: [src/lib/utils/response-unwrapper.ts:346](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/utils/response-unwrapper.ts#L346)

Check if a response is an AdCP success response for a specific task

Uses Zod schemas to validate the response structure matches the expected
success response format for the given task.

## Parameters

### response

`any`

### taskName

`string`

## Returns

`boolean`
