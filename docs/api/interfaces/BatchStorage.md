[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / BatchStorage

# Interface: BatchStorage\<T\>

Defined in: [src/lib/storage/interfaces.ts:186](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L186)

Helper interface for batch operations

## Extends

- [`Storage`](Storage.md)\<`T`\>

## Type Parameters

### T

`T`

## Methods

### get()

> **get**(`key`): `Promise`\<`undefined` \| `T`\>

Defined in: [src/lib/storage/interfaces.ts:16](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L16)

Get a value by key

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`undefined` \| `T`\>

Value or undefined if not found

#### Inherited from

[`Storage`](Storage.md).[`get`](Storage.md#get)

***

### set()

> **set**(`key`, `value`, `ttl?`): `Promise`\<`void`\>

Defined in: [src/lib/storage/interfaces.ts:24](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L24)

Set a value with optional TTL

#### Parameters

##### key

`string`

Storage key

##### value

`T`

Value to store

##### ttl?

`number`

Time to live in seconds (optional)

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`Storage`](Storage.md).[`set`](Storage.md#set)

***

### delete()

> **delete**(`key`): `Promise`\<`void`\>

Defined in: [src/lib/storage/interfaces.ts:30](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L30)

Delete a value by key

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`Storage`](Storage.md).[`delete`](Storage.md#delete)

***

### has()

> **has**(`key`): `Promise`\<`boolean`\>

Defined in: [src/lib/storage/interfaces.ts:36](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L36)

Check if a key exists

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`boolean`\>

#### Inherited from

[`Storage`](Storage.md).[`has`](Storage.md#has)

***

### clear()?

> `optional` **clear**(): `Promise`\<`void`\>

Defined in: [src/lib/storage/interfaces.ts:41](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L41)

Clear all stored values (optional)

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`Storage`](Storage.md).[`clear`](Storage.md#clear)

***

### keys()?

> `optional` **keys**(): `Promise`\<`string`[]\>

Defined in: [src/lib/storage/interfaces.ts:46](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L46)

Get all keys (optional, for debugging)

#### Returns

`Promise`\<`string`[]\>

#### Inherited from

[`Storage`](Storage.md).[`keys`](Storage.md#keys)

***

### size()?

> `optional` **size**(): `Promise`\<`number`\>

Defined in: [src/lib/storage/interfaces.ts:51](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L51)

Get storage size/count (optional, for monitoring)

#### Returns

`Promise`\<`number`\>

#### Inherited from

[`Storage`](Storage.md).[`size`](Storage.md#size)

***

### mget()

> **mget**(`keys`): `Promise`\<(`undefined` \| `T`)[]\>

Defined in: [src/lib/storage/interfaces.ts:190](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L190)

Get multiple values at once

#### Parameters

##### keys

`string`[]

#### Returns

`Promise`\<(`undefined` \| `T`)[]\>

***

### mset()

> **mset**(`entries`): `Promise`\<`void`\>

Defined in: [src/lib/storage/interfaces.ts:195](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L195)

Set multiple values at once

#### Parameters

##### entries

`object`[]

#### Returns

`Promise`\<`void`\>

***

### mdel()

> **mdel**(`keys`): `Promise`\<`number`\>

Defined in: [src/lib/storage/interfaces.ts:200](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/storage/interfaces.ts#L200)

Delete multiple keys at once

#### Parameters

##### keys

`string`[]

#### Returns

`Promise`\<`number`\>
