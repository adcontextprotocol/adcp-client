---
"@adcp/client": minor
---

Add Zod schema exports for runtime validation with automatic generation

This release adds Zod schema exports alongside existing TypeScript types, enabling runtime validation of AdCP data structures. All core schemas, request schemas, and response schemas are now available as Zod schemas.

**New exports:**
- Core schemas: `MediaBuySchema`, `ProductSchema`, `CreativeAssetSchema`, `TargetingSchema`
- Request schemas: `GetProductsRequestSchema`, `CreateMediaBuyRequestSchema`, `SyncCreativesRequestSchema`, etc.
- Response schemas: `GetProductsResponseSchema`, `CreateMediaBuyResponseSchema`, `SyncCreativesResponseSchema`, etc.

**Features:**
- Runtime validation with detailed error messages
- Type inference from schemas
- Integration with React Hook Form, Formik, etc.
- OpenAPI generation support via zod-to-openapi
- **Automatic generation**: Zod schemas now generated automatically when running `npm run generate-types`
- **CI integration**: Pre-push hooks and CI checks ensure schemas stay in sync

**Automatic workflow:**
```bash
# Sync latest AdCP schemas and generate all types (TypeScript + Zod)
npm run sync-schemas && npm run generate-types
```

**Usage:**
```typescript
import { MediaBuySchema } from '@adcp/client';

const result = MediaBuySchema.safeParse(data);
if (result.success) {
  console.log('Valid!', result.data);
}
```

**Documentation:**
- `docs/ZOD-SCHEMAS.md` - Complete usage guide with NPM distribution details
- `docs/VALIDATION_WORKFLOW.md` - CI integration (existing)
- `examples/zod-validation-example.ts` - Working examples
