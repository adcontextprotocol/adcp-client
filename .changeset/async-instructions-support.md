---
"@adcp/sdk": minor
---

feat(server): `createAdcpServer.instructions` accepts an async function (#1393)

The function form of `instructions` now supports returning a `Promise<string | undefined>`. The framework awaits the result during the MCP `initialize` handshake — the session does not proceed until the promise settles. This enables per-session prose fetched from an async source (brand-manifest registries, KV stores, real-time policy docs) without blocking server construction.

```ts
createAdcpServer({
  // Async function — resolved at MCP initialize time, not at factory construction.
  instructions: async (ctx) => {
    const manifest = await brandManifests.get(ctx.tenant);
    return manifest?.intro ?? defaultProse;
  },
  onInstructionsError: 'skip', // or 'fail' for load-bearing policy
});
```

`onInstructionsError: 'skip' | 'fail'` governs async rejections identically to sync throws. Existing string-form and sync-function-form adopters are unaffected.

New export: `MaybePromise<T>` type alias (`T | Promise<T>`) for use in async-optional callback signatures.
