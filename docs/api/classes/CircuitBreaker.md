[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / CircuitBreaker

# Class: CircuitBreaker

Defined in: [src/lib/utils/index.ts:47](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/utils/index.ts#L47)

Circuit Breaker for handling agent failures

## Constructors

### Constructor

> **new CircuitBreaker**(`agentId`): `CircuitBreaker`

Defined in: [src/lib/utils/index.ts:54](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/utils/index.ts#L54)

#### Parameters

##### agentId

`string`

#### Returns

`CircuitBreaker`

## Methods

### call()

> **call**\<`T`\>(`fn`): `Promise`\<`T`\>

Defined in: [src/lib/utils/index.ts:56](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/utils/index.ts#L56)

#### Type Parameters

##### T

`T`

#### Parameters

##### fn

() => `Promise`\<`T`\>

#### Returns

`Promise`\<`T`\>
