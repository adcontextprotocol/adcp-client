---
'@adcp/sdk': major
---

fix(codegen): extend TS7056 annotation list for 3.1.0-beta.2 compound schemas

The 3.1.0-beta.2 schema bundle pushed four more generated Zod schemas past TypeScript's `.d.ts` serialization limit (TS7056). The post-processor in `scripts/generate-zod-from-ts.ts` already handled this for `AdCPAsyncResponseDataSchema` and `MCPWebhookPayloadSchema` by appending a `z.ZodType` annotation; this PR extends the mechanism so the new offenders also get correct typing.

**Changes:**
- `TS7056_SCHEMAS` entries now carry an optional `tsType` so the annotation can be `z.ZodType<T, T>` (Zod v4 two-type-param form). This makes `z.input<typeof Schema>` resolve to the typed shape — important because `AdcpToolMap` reads `params` via `z.input<...>`.
- `& Record<string, unknown>` widening reflects the runtime `.passthrough()` behavior these schemas use; without it, callers passing parsed values to functions expecting `Record<string, unknown>` get a missing-index-signature error.
- Auto-inject `import type { ... } from './tools.generated'` for the typed schemas.
- Newly annotated: `PreviewCreativeRequestSchema`, `UpdateMediaBuyRequestSchema`, `UpdateMediaBuyResponseSchema`, `BuildCreativeResponseSchema`, `SyncEventSourcesResponseSchema`.
- One-line cast at the `withOptionalAccount(UpdateMediaBuyRequestSchema)` call site so the framework helper's `z.ZodObject<...>` constraint is satisfied; runtime shape unchanged.

Part of the #1902 8.0-beta sweep (closes the final compile gap — `build:lib` now produces dist .d.ts cleanly).
