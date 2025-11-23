[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CreativeAgentClient

# Class: CreativeAgentClient

Defined in: [src/lib/core/CreativeAgentClient.ts:41](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L41)

Creative Agent Client - Specialized client for interacting with creative agents

Creative agents provide creative format catalogs and creative assembly services.
This client provides a simplified interface for common creative agent operations.

## Example

```typescript
// Standard creative agent
const creativeAgent = new CreativeAgentClient({
  agentUrl: 'https://creative.adcontextprotocol.org/mcp'
});

// List available formats
const formats = await creativeAgent.listFormats();

// Find specific format
const banner = formats.find(f => f.format_id.id === 'display_300x250_image');
```

## Constructors

### Constructor

> **new CreativeAgentClient**(`config`): `CreativeAgentClient`

Defined in: [src/lib/core/CreativeAgentClient.ts:45](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L45)

#### Parameters

##### config

[`CreativeAgentClientConfig`](../interfaces/CreativeAgentClientConfig.md)

#### Returns

`CreativeAgentClient`

## Methods

### listFormats()

> **listFormats**(`params`): `Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Defined in: [src/lib/core/CreativeAgentClient.ts:78](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L78)

List all available creative formats

#### Parameters

##### params

[`ListCreativeFormatsRequest`](../interfaces/ListCreativeFormatsRequest.md) = `{}`

Optional filtering parameters

#### Returns

`Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Promise resolving to array of creative formats

#### Example

```typescript
const formats = await creativeAgent.listFormats();

// Filter to display formats
const displayFormats = formats.filter(f => f.type === 'display');

// Find by dimensions
const banners = formats.filter(f =>
  f.renders?.[0]?.dimensions?.width === 300 &&
  f.renders?.[0]?.dimensions?.height === 250
);
```

***

### findByType()

> **findByType**(`type`): `Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Defined in: [src/lib/core/CreativeAgentClient.ts:104](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L104)

Find formats by type

#### Parameters

##### type

[`CreativeFormatType`](../type-aliases/CreativeFormatType.md)

Format type to filter by

#### Returns

`Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Promise resolving to matching formats

#### Example

```typescript
const videoFormats = await creativeAgent.findByType('video');
const displayFormats = await creativeAgent.findByType('display');
```

***

### findByDimensions()

> **findByDimensions**(`width`, `height`): `Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Defined in: [src/lib/core/CreativeAgentClient.ts:122](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L122)

Find formats by dimensions

#### Parameters

##### width

`number`

Width in pixels

##### height

`number`

Height in pixels

#### Returns

`Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Promise resolving to matching formats

#### Example

```typescript
// Find all 300x250 formats
const mediumRectangles = await creativeAgent.findByDimensions(300, 250);
```

***

### findById()

> **findById**(`formatId`): `Promise`\<`undefined` \| [`CreativeFormat`](../interfaces/CreativeFormat.md)\>

Defined in: [src/lib/core/CreativeAgentClient.ts:147](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L147)

Find format by ID

#### Parameters

##### formatId

`string`

Format ID to search for

#### Returns

`Promise`\<`undefined` \| [`CreativeFormat`](../interfaces/CreativeFormat.md)\>

Promise resolving to matching format or undefined

#### Example

```typescript
const format = await creativeAgent.findById('display_300x250_image');
if (format) {
  console.log(`Found: ${format.name}`);
}
```

***

### getAgentUrl()

> **getAgentUrl**(): `string`

Defined in: [src/lib/core/CreativeAgentClient.ts:155](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L155)

Get the agent URL

#### Returns

`string`

***

### getClient()

> **getClient**(): [`SingleAgentClient`](SingleAgentClient.md)

Defined in: [src/lib/core/CreativeAgentClient.ts:162](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L162)

Get the underlying single-agent client for advanced operations

#### Returns

[`SingleAgentClient`](SingleAgentClient.md)
