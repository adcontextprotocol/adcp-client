[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ValidationOptions

# Interface: ValidationOptions

Defined in: [src/lib/core/ResponseValidator.ts:19](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L19)

## Properties

### strict?

> `optional` **strict**: `boolean`

Defined in: [src/lib/core/ResponseValidator.ts:21](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L21)

Enable strict mode - fail on warnings

***

### expectedFields?

> `optional` **expectedFields**: `string`[]

Defined in: [src/lib/core/ResponseValidator.ts:23](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L23)

Expected data fields (e.g., ['products'] for get_products)

***

### allowEmpty?

> `optional` **allowEmpty**: `boolean`

Defined in: [src/lib/core/ResponseValidator.ts:25](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L25)

Allow empty responses

***

### validateSchema?

> `optional` **validateSchema**: `boolean`

Defined in: [src/lib/core/ResponseValidator.ts:27](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L27)

Validate against AdCP Zod schemas
