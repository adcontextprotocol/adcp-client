[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / creativeAgent

# Variable: creativeAgent

> `const` **creativeAgent**: [`CreativeAgentClient`](../classes/CreativeAgentClient.md)

Defined in: [src/lib/testing/test-helpers.ts:268](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/testing/test-helpers.ts#L268)

Pre-configured creative agent client using MCP protocol.
Ready to use for creative generation and format listing.

## Examples

```typescript
import { creativeAgent } from '@adcp/client/testing';

// List available creative formats
const formats = await creativeAgent.listFormats();
console.log(`Found ${formats.length} creative formats`);

// Filter to specific format types
const videoFormats = formats.filter(f => f.type === 'video');
const displayFormats = formats.filter(f => f.type === 'display');
```

```typescript
// Find formats by dimensions
const formats = await creativeAgent.listFormats();
const banner = formats.find(f =>
  f.renders?.[0]?.dimensions?.width === 300 &&
  f.renders?.[0]?.dimensions?.height === 250
);
```

## Remarks

This is the official AdCP reference creative agent.
No authentication required for public endpoints.
