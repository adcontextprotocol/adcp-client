---
'@adcp/sdk': minor
---

Adds TypeScript request/response interfaces for the AdCP v2.5 wire shape, importable via `@adcp/sdk/types/v2-5`. This unlocks compile-time type safety on adapter code that maps between v3 and v2.5 — a v3→v2 wire-format bug that previously surfaced only at runtime via the warn-only validation pass now becomes a TypeScript error at the adapter signature.

`scripts/generate-v2-5-types.ts` (`npm run generate-types:v2.5`) compiles every v2.5 tool's request and response schema as a single mega-schema with shared `definitions`, then runs `json-schema-to-typescript` once. The mega-schema approach naturally deduplicates shared types (e.g. `BrandID`, `FormatID`, `AssetContentType`) instead of producing per-tool copies that collide at the type level.

Output lands at `src/lib/types/v2-5/tools.generated.ts` and is checked in (parallel to `src/lib/types/tools.generated.ts` for v3). CI's "Validate generated files in sync" step runs both v3 and v2.5 generation, so a forgotten regeneration after a schema refresh fails the build before it ships. The generator pulls from `schemas/cache/v2.5/`, populated by `npm run sync-schemas:v2.5`.

Consumers can import the v2.5 surface as a namespace:

```ts
import * as V25 from '@adcp/sdk/types/v2-5';
const req: V25.CreateMediaBuyRequest = ...;
```

Or by name:

```ts
import type { CreateMediaBuyRequest } from '@adcp/sdk/types/v2-5';
```

13 tools across the media-buy, creative, and signals protocols ship with both Request and Response interfaces (26 entry-point types). Foundation for the upcoming adapter-registry refactor where adapter signatures become `(req: V3Request) => V25Request` and the buyer_ref-shaped bug becomes a compile error.

The `enforceStrictSchema` helper from the existing v3 generator is now exported so the v2.5 generator can apply the same JSON-Schema preprocessing (strip `additionalProperties: true`, drop `if/then/else` conditionals, recurse into combinators). No v3 behavior change.
