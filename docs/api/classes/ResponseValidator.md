[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ResponseValidator

# Class: ResponseValidator

Defined in: [src/lib/core/ResponseValidator.ts:30](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L30)

## Constructors

### Constructor

> **new ResponseValidator**(): `ResponseValidator`

#### Returns

`ResponseValidator`

## Methods

### validate()

> **validate**(`response`, `toolName?`, `options?`): [`ValidationResult`](../interfaces/ValidationResult.md)

Defined in: [src/lib/core/ResponseValidator.ts:34](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L34)

Validate an agent response structure

#### Parameters

##### response

`any`

##### toolName?

`string`

##### options?

[`ValidationOptions`](../interfaces/ValidationOptions.md) = `{}`

#### Returns

[`ValidationResult`](../interfaces/ValidationResult.md)

***

### validateOrThrow()

> **validateOrThrow**(`response`, `toolName?`, `options?`): `void`

Defined in: [src/lib/core/ResponseValidator.ts:245](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L245)

Quick validation helper - returns true if valid, throws if invalid

#### Parameters

##### response

`any`

##### toolName?

`string`

##### options?

[`ValidationOptions`](../interfaces/ValidationOptions.md) = `{}`

#### Returns

`void`

***

### isValidProtocolResponse()

> **isValidProtocolResponse**(`response`): `boolean`

Defined in: [src/lib/core/ResponseValidator.ts:256](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L256)

Check if a response looks like a valid protocol response

#### Parameters

##### response

`any`

#### Returns

`boolean`
