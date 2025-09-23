[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / isErrorOfType

# Function: isErrorOfType()

> **isErrorOfType**\<`T`\>(`error`, `ErrorClass`): `error is T`

Defined in: [src/lib/errors/index.ts:181](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/errors/index.ts#L181)

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
