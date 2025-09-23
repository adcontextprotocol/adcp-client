[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / AdCPClient

# ~~Class: AdCPClient~~

Defined in: [src/lib/index.ts:109](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L109)

Legacy AdCPClient for backward compatibility - now redirects to ADCPMultiAgentClient

## Deprecated

Use ADCPMultiAgentClient instead for new code

## Constructors

### Constructor

> **new AdCPClient**(`agents?`): `AdCPClient`

Defined in: [src/lib/index.ts:112](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L112)

#### Parameters

##### agents?

[`AgentConfig`](../interfaces/AgentConfig.md)[]

#### Returns

`AdCPClient`

## Accessors

### ~~agentCount~~

#### Get Signature

> **get** **agentCount**(): `number`

Defined in: [src/lib/index.ts:121](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L121)

##### Returns

`number`

***

### ~~agentIds~~

#### Get Signature

> **get** **agentIds**(): `string`[]

Defined in: [src/lib/index.ts:122](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L122)

##### Returns

`string`[]

## Methods

### ~~agent()~~

> **agent**(`id`): [`AgentClient`](AgentClient.md)

Defined in: [src/lib/index.ts:116](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L116)

#### Parameters

##### id

`string`

#### Returns

[`AgentClient`](AgentClient.md)

***

### ~~agents()~~

> **agents**(`ids`): [`NewAgentCollection`](NewAgentCollection.md)

Defined in: [src/lib/index.ts:117](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L117)

#### Parameters

##### ids

`string`[]

#### Returns

[`NewAgentCollection`](NewAgentCollection.md)

***

### ~~allAgents()~~

> **allAgents**(): [`NewAgentCollection`](NewAgentCollection.md)

Defined in: [src/lib/index.ts:118](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L118)

#### Returns

[`NewAgentCollection`](NewAgentCollection.md)

***

### ~~addAgent()~~

> **addAgent**(`agent`): `void`

Defined in: [src/lib/index.ts:119](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L119)

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

#### Returns

`void`

***

### ~~getAgents()~~

> **getAgents**(): [`AgentConfig`](../interfaces/AgentConfig.md)[]

Defined in: [src/lib/index.ts:120](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L120)

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)[]

***

### ~~getStandardFormats()~~

> **getStandardFormats**(): `any`

Defined in: [src/lib/index.ts:124](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/index.ts#L124)

#### Returns

`any`
