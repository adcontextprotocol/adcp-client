---
"@adcp/sdk": minor
---

feat(server): add `definePlatform` / `defineSalesPlatform` / `defineAudiencePlatform` (and one per remaining specialism) identity helpers

Fixes the TypeScript contextual-typing gap that caused handler method parameters to
resolve as `req: unknown` when a `DecisioningPlatform` (or sub-interface) was built as
an object literal and passed directly to `createAdcpServerFromPlatform`.

Root cause: `createAdcpServerFromPlatform<P extends DecisioningPlatform<any,any>>(platform: P & ...)`
infers `P` from the argument rather than using the constraint for contextual typing, so
nested method parameters (`req`, `ctx`) can't be contextually typed from the interface.

The helpers are pure identity functions that force a concrete `DecisioningPlatform<TConfig, TCtxMeta>`
(or per-specialism sub-interface) as the declared parameter type, giving TypeScript the
annotation it needs:

```ts
// Before — req: unknown, 16 manual casts
createAdcpServerFromPlatform({
  sales: {
    syncEventSources: async (req, ctx) => {
      const sources = ((req as { event_sources?: unknown[] }).event_sources ?? [])...
    }
  }
}, opts);

// After — req: SyncEventSourcesRequest ✓, ctx.account.ctx_metadata: SocialMeta ✓
createAdcpServerFromPlatform({
  sales: defineSalesPlatform<SocialMeta>({
    syncEventSources: async (req, ctx) => {
      const sources = req.event_sources ?? [];  // no cast
    }
  })
}, opts);
```

The class pattern with explicit property-type annotations (`sales: SalesPlatform<Meta> = {...}`)
continues to work without any helper. The helpers are the object-literal escape hatch.

Also fixes a misleading note in `skills/build-seller-agent/specialisms/sales-social.md` that
described handler-bag grouping for the legacy `createAdcpServer` path, which steered LLM
adopters toward `req: unknown` handlers instead of the typed platform interface. Replaced
with the `createAdcpServerFromPlatform` method-mapping table.
