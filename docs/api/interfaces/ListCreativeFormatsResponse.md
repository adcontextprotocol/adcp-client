[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ListCreativeFormatsResponse

# Interface: ListCreativeFormatsResponse

Defined in: [src/lib/types/tools.generated.ts:1078](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1078)

Response payload for list_creative_formats task

## Properties

### formats

> **formats**: [`Format`](Format.md)[]

Defined in: [src/lib/types/tools.generated.ts:1082](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1082)

Full format definitions for all formats this agent supports. Each format's authoritative source is indicated by its agent_url field.

***

### creative\_agents?

> `optional` **creative\_agents**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:1086](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1086)

Optional: Creative agents that provide additional formats. Buyers can recursively query these agents to discover more formats. No authentication required for list_creative_formats.

#### agent\_url

> **agent\_url**: `string`

Base URL for the creative agent (e.g., 'https://reference.adcp.org', 'https://dco.example.com'). Call list_creative_formats on this URL to get its formats.

#### agent\_name?

> `optional` **agent\_name**: `string`

Human-readable name for the creative agent

#### capabilities?

> `optional` **capabilities**: (`"preview"` \| `"validation"` \| `"assembly"` \| `"generation"`)[]

Capabilities this creative agent provides

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:1103](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1103)

Task-specific errors and warnings (e.g., format availability issues)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:1107](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1107)

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
