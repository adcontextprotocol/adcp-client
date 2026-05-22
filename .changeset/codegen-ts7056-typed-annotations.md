---
'@adcp/sdk': patch
---

fix(codegen): extend TS7056 post-processor to emit typed `z.ZodType<T, T>` annotations

The Zod-from-TS post-processor in `scripts/generate-zod-from-ts.ts` annotates schemas that hit TypeScript's `.d.ts` serialization limit (TS7056) with `z.ZodType` so the compiler stops trying to serialize the inferred shape. The previous annotation used the bare `z.ZodType` form, which makes `z.input<typeof X>` resolve to `unknown` — breaking `AdcpToolMap[K]['params']` narrowing for any annotated request schema.

**Changes:**

- `TS7056_SCHEMAS` entries now carry an optional `tsType` field. When present, the annotation uses the 2-type-param Zod v4 form `z.ZodType<T, T>` with `& Record<string, unknown>` widening to reflect runtime `.passthrough()` semantics. Callers' `z.input<...>` reads resolve to the typed shape; downstream destructures keep their field types.
- Auto-inject `import type { ... } from './tools.generated'` for the typed annotations.
- Pre-emptively annotate five additional schemas (`PreviewCreativeRequestSchema`, `UpdateMediaBuyRequestSchema`, `UpdateMediaBuyResponseSchema`, `BuildCreativeResponseSchema`, `SyncEventSourcesResponseSchema`) — they hit TS7056 on 3.1.0-beta.2 and the annotation is harmless on the current 3.0.12 pin.
- One-line cast at the `withOptionalAccount(UpdateMediaBuyRequestSchema)` call site so the framework helper's `z.ZodObject<...>` constraint is satisfied after the annotation widening. Runtime shape unchanged.

**Why pre-emptive:** the 8.0-beta cut (#1902) needs this codegen behavior to compile its `dist/`. Landing the codegen-tooling fix on `main` decouples it from the 8.0-beta foundation stack and gives any future 3.0.x patch that introduces compound-schema complexity the same treatment for free.
