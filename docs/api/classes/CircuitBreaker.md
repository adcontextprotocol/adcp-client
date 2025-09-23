[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / CircuitBreaker

# Class: CircuitBreaker

Defined in: [src/lib/utils/index.ts:47](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/utils/index.ts#L47)

Circuit Breaker for handling agent failures

## Constructors

### Constructor

> **new CircuitBreaker**(`agentId`): `CircuitBreaker`

Defined in: [src/lib/utils/index.ts:54](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/utils/index.ts#L54)

#### Parameters

##### agentId

`string`

#### Returns

`CircuitBreaker`

## Methods

### call()

> **call**\<`T`\>(`fn`): `Promise`\<`T`\>

Defined in: [src/lib/utils/index.ts:56](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/utils/index.ts#L56)

#### Type Parameters

##### T

`T`

#### Parameters

##### fn

() => `Promise`\<`T`\>

#### Returns

`Promise`\<`T`\>
