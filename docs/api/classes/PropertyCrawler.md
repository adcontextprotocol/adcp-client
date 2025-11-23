[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / PropertyCrawler

# Class: PropertyCrawler

Defined in: [src/lib/discovery/property-crawler.ts:36](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-crawler.ts#L36)

## Constructors

### Constructor

> **new PropertyCrawler**(`config?`): `PropertyCrawler`

Defined in: [src/lib/discovery/property-crawler.ts:39](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-crawler.ts#L39)

#### Parameters

##### config?

`PropertyCrawlerConfig`

#### Returns

`PropertyCrawler`

## Methods

### crawlAgents()

> **crawlAgents**(`agents`): `Promise`\<[`CrawlResult`](../interfaces/CrawlResult.md)\>

Defined in: [src/lib/discovery/property-crawler.ts:47](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-crawler.ts#L47)

Crawl multiple agents to discover their publisher domains and properties

#### Parameters

##### agents

[`AgentInfo`](../interfaces/AgentInfo.md)[]

#### Returns

`Promise`\<[`CrawlResult`](../interfaces/CrawlResult.md)\>

***

### crawlAgent()

> **crawlAgent**(`agentInfo`): `Promise`\<`string`[]\>

Defined in: [src/lib/discovery/property-crawler.ts:119](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-crawler.ts#L119)

Crawl a single agent to get its authorized publisher domains

#### Parameters

##### agentInfo

[`AgentInfo`](../interfaces/AgentInfo.md)

#### Returns

`Promise`\<`string`[]\>

***

### fetchPublisherProperties()

> **fetchPublisherProperties**(`domains`): `Promise`\<\{ `properties`: `Record`\<`string`, [`Property`](../interfaces/Property.md)[]\>; `warnings`: `object`[]; \}\>

Defined in: [src/lib/discovery/property-crawler.ts:144](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-crawler.ts#L144)

Fetch adagents.json from multiple publisher domains

#### Parameters

##### domains

`string`[]

#### Returns

`Promise`\<\{ `properties`: `Record`\<`string`, [`Property`](../interfaces/Property.md)[]\>; `warnings`: `object`[]; \}\>

***

### fetchAdAgentsJson()

> **fetchAdAgentsJson**(`domain`): `Promise`\<\{ `properties`: [`Property`](../interfaces/Property.md)[]; `warning?`: `string`; \}\>

Defined in: [src/lib/discovery/property-crawler.ts:205](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/discovery/property-crawler.ts#L205)

Fetch and parse adagents.json from a publisher domain

#### Parameters

##### domain

`string`

#### Returns

`Promise`\<\{ `properties`: [`Property`](../interfaces/Property.md)[]; `warning?`: `string`; \}\>
