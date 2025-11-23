[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ConfigurationManager

# Class: ConfigurationManager

Defined in: [src/lib/core/ConfigurationManager.ts:34](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L34)

Enhanced configuration manager with multiple loading strategies

## Constructors

### Constructor

> **new ConfigurationManager**(): `ConfigurationManager`

#### Returns

`ConfigurationManager`

## Methods

### loadAgents()

> `static` **loadAgents**(): [`AgentConfig`](../interfaces/AgentConfig.md)[]

Defined in: [src/lib/core/ConfigurationManager.ts:46](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L46)

Load agent configurations using auto-discovery
Tries multiple sources in order:
1. Environment variables
2. Config files in current directory
3. Config files in project root

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)[]

***

### loadAgentsFromEnv()

> `static` **loadAgentsFromEnv**(): [`AgentConfig`](../interfaces/AgentConfig.md)[]

Defined in: [src/lib/core/ConfigurationManager.ts:73](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L73)

Load agents from environment variables

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)[]

***

### loadAgentsFromConfig()

> `static` **loadAgentsFromConfig**(`configPath?`): [`AgentConfig`](../interfaces/AgentConfig.md)[]

Defined in: [src/lib/core/ConfigurationManager.ts:100](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L100)

Load agents from config file

#### Parameters

##### configPath?

`string`

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)[]

***

### validateAgentConfig()

> `static` **validateAgentConfig**(`agent`): `void`

Defined in: [src/lib/core/ConfigurationManager.ts:165](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L165)

Validate agent configuration

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

#### Returns

`void`

***

### validateAgentsConfig()

> `static` **validateAgentsConfig**(`agents`): `void`

Defined in: [src/lib/core/ConfigurationManager.ts:189](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L189)

Validate multiple agent configurations

#### Parameters

##### agents

[`AgentConfig`](../interfaces/AgentConfig.md)[]

#### Returns

`void`

***

### createSampleConfig()

> `static` **createSampleConfig**(): `ADCPConfig`

Defined in: [src/lib/core/ConfigurationManager.ts:212](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L212)

Create a sample configuration file

#### Returns

`ADCPConfig`

***

### getConfigPaths()

> `static` **getConfigPaths**(): `string`[]

Defined in: [src/lib/core/ConfigurationManager.ts:243](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L243)

Get configuration file paths that would be checked

#### Returns

`string`[]

***

### getEnvVars()

> `static` **getEnvVars**(): `string`[]

Defined in: [src/lib/core/ConfigurationManager.ts:250](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L250)

Get environment variables that would be checked

#### Returns

`string`[]

***

### getConfigurationHelp()

> `static` **getConfigurationHelp**(): `string`

Defined in: [src/lib/core/ConfigurationManager.ts:257](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConfigurationManager.ts#L257)

Generate configuration help text

#### Returns

`string`
