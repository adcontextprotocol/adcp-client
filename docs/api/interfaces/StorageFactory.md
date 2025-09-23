[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / StorageFactory

# Interface: StorageFactory

Defined in: [src/lib/storage/interfaces.ts:169](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L169)

Storage factory interface for creating storage instances

## Methods

### createStorage()

> **createStorage**\<`T`\>(`type`, `options?`): [`Storage`](Storage.md)\<`T`\>

Defined in: [src/lib/storage/interfaces.ts:173](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L173)

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
