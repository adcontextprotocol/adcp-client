---
"@adcp/sdk": minor
---

`createAdcpServerFromPlatform` now threads server-level `instructions` to the underlying MCP server, surfacing it on the `initialize` response. Closes #1312.

The new `DecisioningPlatform.instructions?: string` field is the v6 surface — declare platform facts, decision policy, and trends colocated with the rest of the platform definition. The pre-existing `opts.instructions` continues to work as the v5-style escape hatch; when both are set, `platform.instructions` wins (same precedence pattern as `agentRegistry`).

```ts
const platform: DecisioningPlatform = {
  capabilities: { specialisms: ['sales-non-guaranteed'], /* ... */ },
  accounts: { /* ... */ },
  sales: { /* ... */ },
  instructions:
    'Publisher-wide brand safety: alcohol disallowed. ' +
    'Carbon-aware pricing applies to display impressions only. ' +
    'Weekly cutoff: Thursday 17:00 UTC.',
};
const server = createAdcpServerFromPlatform(platform, opts);
```

Surfaced from the storefront-platform port in `scope3data/agentic-adapters#237`, which had to defer publishing v5 `instructions` on the v6 path.
