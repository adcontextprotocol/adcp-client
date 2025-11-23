[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ValidationResult

# Interface: ValidationResult

Defined in: [src/lib/core/ResponseValidator.ts:11](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L11)

## Properties

### valid

> **valid**: `boolean`

Defined in: [src/lib/core/ResponseValidator.ts:12](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L12)

***

### errors

> **errors**: `string`[]

Defined in: [src/lib/core/ResponseValidator.ts:13](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L13)

***

### warnings

> **warnings**: `string`[]

Defined in: [src/lib/core/ResponseValidator.ts:14](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L14)

***

### protocol?

> `optional` **protocol**: `"mcp"` \| `"a2a"` \| `"unknown"`

Defined in: [src/lib/core/ResponseValidator.ts:15](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L15)

***

### schemaErrors?

> `optional` **schemaErrors**: `$ZodIssue`[]

Defined in: [src/lib/core/ResponseValidator.ts:16](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ResponseValidator.ts#L16)
