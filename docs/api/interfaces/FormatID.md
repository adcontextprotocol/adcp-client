[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / FormatID

# Interface: FormatID

Defined in: [src/lib/types/core.generated.ts:161](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/core.generated.ts#L161)

Structured format identifier with agent URL and format name

## Properties

### agent\_url

> **agent\_url**: `string`

Defined in: [src/lib/types/core.generated.ts:165](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/core.generated.ts#L165)

URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)

***

### id

> **id**: `string`

Defined in: [src/lib/types/core.generated.ts:169](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/core.generated.ts#L169)

Format identifier within the agent's namespace (e.g., 'display_300x250', 'video_standard_30s')
