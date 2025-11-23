[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / PropertyIndex

# Class: PropertyIndex

Defined in: [src/lib/discovery/property-index.ts:27](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-index.ts#L27)

Singleton in-memory property index

## Constructors

### Constructor

> **new PropertyIndex**(): `PropertyIndex`

#### Returns

`PropertyIndex`

## Methods

### findAgentsForProperty()

> **findAgentsForProperty**(`identifierType`, `identifierValue`): [`PropertyMatch`](../interfaces/PropertyMatch.md)[]

Defined in: [src/lib/discovery/property-index.ts:37](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-index.ts#L37)

Query 1: Find agents that can sell a specific property

#### Parameters

##### identifierType

[`PropertyIdentifierType`](../type-aliases/PropertyIdentifierType.md)

##### identifierValue

`string`

#### Returns

[`PropertyMatch`](../interfaces/PropertyMatch.md)[]

***

### getAgentAuthorizations()

> **getAgentAuthorizations**(`agentUrl`): `null` \| [`AgentAuthorization`](../interfaces/AgentAuthorization.md)

Defined in: [src/lib/discovery/property-index.ts:45](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-index.ts#L45)

Query 2: Get all properties an agent can sell

#### Parameters

##### agentUrl

`string`

#### Returns

`null` \| [`AgentAuthorization`](../interfaces/AgentAuthorization.md)

***

### findAgentsByPropertyTags()

> **findAgentsByPropertyTags**(`tags`): [`PropertyMatch`](../interfaces/PropertyMatch.md)[]

Defined in: [src/lib/discovery/property-index.ts:52](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-index.ts#L52)

Query 3: Find agents by property tags

#### Parameters

##### tags

`string`[]

#### Returns

[`PropertyMatch`](../interfaces/PropertyMatch.md)[]

***

### addProperty()

> **addProperty**(`property`, `agentUrl`, `publisherDomain`): `void`

Defined in: [src/lib/discovery/property-index.ts:82](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-index.ts#L82)

Add a property to the index

#### Parameters

##### property

[`Property`](../interfaces/Property.md)

##### agentUrl

`string`

##### publisherDomain

`string`

#### Returns

`void`

***

### addAgentAuthorization()

> **addAgentAuthorization**(`agentUrl`, `publisherDomains`): `void`

Defined in: [src/lib/discovery/property-index.ts:118](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-index.ts#L118)

Add agent → publisher_domains authorization

#### Parameters

##### agentUrl

`string`

##### publisherDomains

`string`[]

#### Returns

`void`

***

### clear()

> **clear**(): `void`

Defined in: [src/lib/discovery/property-index.ts:139](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-index.ts#L139)

Clear all data from the index

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Defined in: [src/lib/discovery/property-index.ts:147](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-index.ts#L147)

Get statistics about the index

#### Returns

`object`

##### totalIdentifiers

> **totalIdentifiers**: `number`

##### totalAgents

> **totalAgents**: `number`

##### totalProperties

> **totalProperties**: `number`
