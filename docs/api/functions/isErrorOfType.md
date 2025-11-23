[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / isErrorOfType

# Function: isErrorOfType()

> **isErrorOfType**\<`T`\>(`error`, `ErrorClass`): `error is T`

Defined in: [src/lib/errors/index.ts:187](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/errors/index.ts#L187)

Type guard to check if an error is a specific ADCP error type

## Type Parameters

### T

`T` *extends* [`ADCPError`](../classes/ADCPError.md)

## Parameters

### error

`unknown`

### ErrorClass

(...`args`) => `T`

## Returns

`error is T`
