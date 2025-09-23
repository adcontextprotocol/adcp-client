[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ConfigurationManager

# Class: ConfigurationManager

Defined in: [src/lib/core/ConfigurationManager.ts:34](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L34)

Enhanced configuration manager with multiple loading strategies

## Constructors

### Constructor

> **new ConfigurationManager**(): `ConfigurationManager`

#### Returns

`ConfigurationManager`

## Methods

### loadAgents()

> `static` **loadAgents**(): [`AgentConfig`](../interfaces/AgentConfig.md)[]

Defined in: [src/lib/core/ConfigurationManager.ts:55](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L55)

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

Defined in: [src/lib/core/ConfigurationManager.ts:82](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L82)

Load agents from environment variables

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)[]

***

### loadAgentsFromConfig()

> `static` **loadAgentsFromConfig**(`configPath?`): [`AgentConfig`](../interfaces/AgentConfig.md)[]

Defined in: [src/lib/core/ConfigurationManager.ts:112](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L112)

Load agents from config file

#### Parameters

##### configPath?

`string`

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)[]

***

### validateAgentConfig()

> `static` **validateAgentConfig**(`agent`): `void`

Defined in: [src/lib/core/ConfigurationManager.ts:180](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L180)

Validate agent configuration

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

#### Returns

`void`

***

### validateAgentsConfig()

> `static` **validateAgentsConfig**(`agents`): `void`

Defined in: [src/lib/core/ConfigurationManager.ts:213](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L213)

Validate multiple agent configurations

#### Parameters

##### agents

[`AgentConfig`](../interfaces/AgentConfig.md)[]

#### Returns

`void`

***

### createSampleConfig()

> `static` **createSampleConfig**(): `ADCPConfig`

Defined in: [src/lib/core/ConfigurationManager.ts:239](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L239)

Create a sample configuration file

#### Returns

`ADCPConfig`

***

### getConfigPaths()

> `static` **getConfigPaths**(): `string`[]

Defined in: [src/lib/core/ConfigurationManager.ts:270](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L270)

Get configuration file paths that would be checked

#### Returns

`string`[]

***

### getEnvVars()

> `static` **getEnvVars**(): `string`[]

Defined in: [src/lib/core/ConfigurationManager.ts:277](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L277)

Get environment variables that would be checked

#### Returns

`string`[]

***

### getConfigurationHelp()

> `static` **getConfigurationHelp**(): `string`

Defined in: [src/lib/core/ConfigurationManager.ts:284](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConfigurationManager.ts#L284)

Generate configuration help text

#### Returns

`string`
