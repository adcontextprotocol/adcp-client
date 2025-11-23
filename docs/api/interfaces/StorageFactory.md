[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / StorageFactory

# Interface: StorageFactory

Defined in: [src/lib/storage/interfaces.ts:169](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L169)

Storage factory interface for creating storage instances

## Methods

### createStorage()

> **createStorage**\<`T`\>(`type`, `options?`): [`Storage`](Storage.md)\<`T`\>

Defined in: [src/lib/storage/interfaces.ts:173](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L173)

Create a storage instance for a specific data type

#### Type Parameters

##### T

`T`

#### Parameters

##### type

`string`

##### options?

`any`

#### Returns

[`Storage`](Storage.md)\<`T`\>
