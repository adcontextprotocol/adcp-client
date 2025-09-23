[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / Storage

# Interface: Storage\<T\>

Defined in: [src/lib/storage/interfaces.ts:10](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L10)

Generic storage interface for caching and persistence

Users can provide their own implementations (Redis, database, etc.)
The library provides a default in-memory implementation

## Extended by

- [`BatchStorage`](BatchStorage.md)
- [`PatternStorage`](PatternStorage.md)

## Type Parameters

### T

`T`

## Methods

### get()

> **get**(`key`): `Promise`\<`undefined` \| `T`\>

Defined in: [src/lib/storage/interfaces.ts:16](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L16)

Get a value by key

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`undefined` \| `T`\>

Value or undefined if not found

***

### set()

> **set**(`key`, `value`, `ttl?`): `Promise`\<`void`\>

Defined in: [src/lib/storage/interfaces.ts:24](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L24)

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

***

### delete()

> **delete**(`key`): `Promise`\<`void`\>

Defined in: [src/lib/storage/interfaces.ts:30](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L30)

Delete a value by key

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`void`\>

***

### has()

> **has**(`key`): `Promise`\<`boolean`\>

Defined in: [src/lib/storage/interfaces.ts:36](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L36)

Check if a key exists

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`boolean`\>

***

### clear()?

> `optional` **clear**(): `Promise`\<`void`\>

Defined in: [src/lib/storage/interfaces.ts:41](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L41)

Clear all stored values (optional)

#### Returns

`Promise`\<`void`\>

***

### keys()?

> `optional` **keys**(): `Promise`\<`string`[]\>

Defined in: [src/lib/storage/interfaces.ts:46](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L46)

Get all keys (optional, for debugging)

#### Returns

`Promise`\<`string`[]\>

***

### size()?

> `optional` **size**(): `Promise`\<`number`\>

Defined in: [src/lib/storage/interfaces.ts:51](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L51)

Get storage size/count (optional, for monitoring)

#### Returns

`Promise`\<`number`\>
