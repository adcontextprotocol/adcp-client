---
"@adcp/sdk": minor
---

feat(server): `platform.instructions` accepts an async function evaluated per MCP session (#1347)

`DecisioningPlatform.instructions` now accepts a function in addition to a string:

```ts
defineSalesPlatform({
  instructions: async (ctx) => fetchPolicyDoc(ctx.agent?.agent_id),
});
```

The function is called once per MCP `initialize` handshake (once per buyer session) and cached for the session lifetime. Existing string adopters are unaffected.

New `InstructionsContext` type (`{ authInfo?, agent? }`) is available in the same import path as `DecisioningPlatform`. New `onInstructionsError: 'skip' | 'fail'` option on `CreateAdcpServerFromPlatformOptions` controls behavior when the function throws (default `'skip'` — session proceeds without instructions).

Function form is incompatible with `reuseAgent: true` in `serve()`; the framework throws at request time when this combination is detected.
