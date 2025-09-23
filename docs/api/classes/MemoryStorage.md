[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / MemoryStorage

# Class: MemoryStorage\<T\>

Defined in: [src/lib/storage/MemoryStorage.ts:32](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L32)

In-memory storage implementation with TTL support

This is the default storage used when no external storage is configured.
Features:
- TTL support with automatic cleanup
- Pattern matching
- Batch operations
- Memory-efficient (garbage collection of expired items)

## Example

```typescript
const storage = new MemoryStorage<string>();
await storage.set('key', 'value', 60); // TTL of 60 seconds
const value = await storage.get('key');
```

## Type Parameters

### T

`T`

## Implements

- [`Storage`](../interfaces/Storage.md)\<`T`\>
- [`BatchStorage`](../interfaces/BatchStorage.md)\<`T`\>
- [`PatternStorage`](../interfaces/PatternStorage.md)\<`T`\>

## Constructors

### Constructor

> **new MemoryStorage**\<`T`\>(`options`): `MemoryStorage`\<`T`\>

Defined in: [src/lib/storage/MemoryStorage.ts:37](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L37)

#### Parameters

##### options

###### cleanupIntervalMs?

`number`

How often to clean up expired items (ms), default 5 minutes

###### maxItems?

`number`

Maximum items to store before forcing cleanup, default 10000

###### autoCleanup?

`boolean`

Whether to enable automatic cleanup, default true

#### Returns

`MemoryStorage`\<`T`\>

## Methods

### get()

> **get**(`key`): `Promise`\<`undefined` \| `T`\>

Defined in: [src/lib/storage/MemoryStorage.ts:59](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L59)

Get a value by key

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`undefined` \| `T`\>

Value or undefined if not found

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`get`](../interfaces/PatternStorage.md#get)

***

### set()

> **set**(`key`, `value`, `ttl?`): `Promise`\<`void`\>

Defined in: [src/lib/storage/MemoryStorage.ts:75](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L75)

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

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`set`](../interfaces/PatternStorage.md#set)

***

### delete()

> **delete**(`key`): `Promise`\<`void`\>

Defined in: [src/lib/storage/MemoryStorage.ts:92](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L92)

Delete a value by key

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`delete`](../interfaces/PatternStorage.md#delete)

***

### has()

> **has**(`key`): `Promise`\<`boolean`\>

Defined in: [src/lib/storage/MemoryStorage.ts:96](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L96)

Check if a key exists

#### Parameters

##### key

`string`

Storage key

#### Returns

`Promise`\<`boolean`\>

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`has`](../interfaces/PatternStorage.md#has)

***

### clear()

> **clear**(): `Promise`\<`void`\>

Defined in: [src/lib/storage/MemoryStorage.ts:101](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L101)

Clear all stored values (optional)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`clear`](../interfaces/PatternStorage.md#clear)

***

### keys()

> **keys**(): `Promise`\<`string`[]\>

Defined in: [src/lib/storage/MemoryStorage.ts:105](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L105)

Get all keys (optional, for debugging)

#### Returns

`Promise`\<`string`[]\>

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`keys`](../interfaces/PatternStorage.md#keys)

***

### size()

> **size**(): `Promise`\<`number`\>

Defined in: [src/lib/storage/MemoryStorage.ts:119](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L119)

Get storage size/count (optional, for monitoring)

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`size`](../interfaces/PatternStorage.md#size)

***

### mget()

> **mget**(`keys`): `Promise`\<(`undefined` \| `T`)[]\>

Defined in: [src/lib/storage/MemoryStorage.ts:127](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L127)

Get multiple values at once

#### Parameters

##### keys

`string`[]

#### Returns

`Promise`\<(`undefined` \| `T`)[]\>

#### Implementation of

[`BatchStorage`](../interfaces/BatchStorage.md).[`mget`](../interfaces/BatchStorage.md#mget)

***

### mset()

> **mset**(`entries`): `Promise`\<`void`\>

Defined in: [src/lib/storage/MemoryStorage.ts:132](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L132)

Set multiple values at once

#### Parameters

##### entries

`object`[]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`BatchStorage`](../interfaces/BatchStorage.md).[`mset`](../interfaces/BatchStorage.md#mset)

***

### mdel()

> **mdel**(`keys`): `Promise`\<`number`\>

Defined in: [src/lib/storage/MemoryStorage.ts:137](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L137)

Delete multiple keys at once

#### Parameters

##### keys

`string`[]

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`BatchStorage`](../interfaces/BatchStorage.md).[`mdel`](../interfaces/BatchStorage.md#mdel)

***

### scan()

> **scan**(`pattern`): `Promise`\<`string`[]\>

Defined in: [src/lib/storage/MemoryStorage.ts:150](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L150)

Get keys matching a pattern

#### Parameters

##### pattern

`string`

#### Returns

`Promise`\<`string`[]\>

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`scan`](../interfaces/PatternStorage.md#scan)

***

### deletePattern()

> **deletePattern**(`pattern`): `Promise`\<`number`\>

Defined in: [src/lib/storage/MemoryStorage.ts:156](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L156)

Delete keys matching a pattern

#### Parameters

##### pattern

`string`

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`PatternStorage`](../interfaces/PatternStorage.md).[`deletePattern`](../interfaces/PatternStorage.md#deletepattern)

***

### cleanupExpired()

> **cleanupExpired**(): `number`

Defined in: [src/lib/storage/MemoryStorage.ts:166](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L166)

Manually trigger cleanup of expired items

#### Returns

`number`

***

### getStats()

> **getStats**(): `object`

Defined in: [src/lib/storage/MemoryStorage.ts:184](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L184)

Get storage statistics

#### Returns

`object`

##### totalItems

> **totalItems**: `number`

##### expiredItems

> **expiredItems**: `number`

##### memoryUsage

> **memoryUsage**: `number`

##### lastCleanup

> **lastCleanup**: `number`

##### oldestItem?

> `optional` **oldestItem**: `number`

##### newestItem?

> `optional` **newestItem**: `number`

***

### destroy()

> **destroy**(): `void`

Defined in: [src/lib/storage/MemoryStorage.ts:255](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/storage/MemoryStorage.ts#L255)

Destroy the storage and cleanup resources

#### Returns

`void`
