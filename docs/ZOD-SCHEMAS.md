# Zod Schema Validation

The AdCP client library provides **runtime validation schemas** using [Zod](https://zod.dev), automatically generated from the official AdCP protocol schemas.

## Quick Start

```bash
npm install @adcp/client zod
```

```typescript
import { MediaBuySchema, GetProductsRequestSchema } from '@adcp/client';

// Validate data
const result = MediaBuySchema.safeParse(data);
if (result.success) {
  console.log('Valid!', result.data);
} else {
  console.error('Errors:', result.error.issues);
}
```

## Why Zod Schemas?

- ✅ **Runtime validation** - Catch data issues at runtime, not just compile time
- 🔒 **Type safety** - Infer TypeScript types from schemas
- 🎯 **Error messages** - Detailed validation errors with field paths
- 📝 **Form integration** - Works with React Hook Form, Formik, etc.
- 🌐 **API validation** - Validate requests/responses

## Available Schemas

### Core Types
- `MediaBuySchema`, `ProductSchema`, `CreativeAssetSchema`, `TargetingSchema`

### All AdCP Tasks
- `GetProductsRequestSchema` / `GetProductsResponseSchema`
- `CreateMediaBuyRequestSchema` / `CreateMediaBuyResponseSchema`
- `SyncCreativesRequestSchema` / `SyncCreativesResponseSchema`
- And all other AdCP tasks...

## Common Use Cases

### API Request Validation

```typescript
import { GetProductsRequestSchema } from '@adcp/client';

function callGetProducts(request: unknown) {
  const validated = GetProductsRequestSchema.parse(request);
  return agent.getProducts(validated); // Type-safe!
}
```

### API Response Validation

```typescript
import { GetProductsResponseSchema } from '@adcp/client';

async function fetchProducts() {
  const response = await agent.getProducts(request);
  const validated = GetProductsResponseSchema.parse(response);
  return validated.products; // Guaranteed valid!
}
```

### Form Validation

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CreateMediaBuyRequestSchema } from '@adcp/client';

function MediaBuyForm() {
  const { register, handleSubmit } = useForm({
    resolver: zodResolver(CreateMediaBuyRequestSchema)
  });
  // Form data is automatically validated!
}
```

### Middleware Validation

```typescript
app.post('/api/products', async (req, res) => {
  try {
    const request = GetProductsRequestSchema.parse(req.body);
    const response = await agent.getProducts(request);
    res.json(GetProductsResponseSchema.parse(response));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ errors: error.issues });
    }
  }
});
```

## Advanced Usage

### Partial Schemas
```typescript
const PartialMediaBuy = MediaBuySchema.partial(); // All fields optional
```

### Schema Extension
```typescript
const ProductWithCache = ProductSchema.extend({
  _cached_at: z.string().datetime()
});
```

### Custom Transforms
```typescript
const NormalizedRequest = GetProductsRequestSchema.transform(data => ({
  ...data,
  brief: data.brief?.trim().toLowerCase()
}));
```

## Automatic Generation

Zod schemas are automatically generated when you update types:

```bash
# Sync schemas from protocol and generate everything
npm run sync-schemas && npm run generate-types
```

This single command:
1. Downloads latest AdCP JSON schemas
2. Generates TypeScript types
3. Generates Zod schemas (automatic)

See `VALIDATION_WORKFLOW.md` for CI integration details.

## Error Handling

```typescript
const result = MediaBuySchema.safeParse(invalidData);

if (!result.success) {
  result.error.issues.forEach(issue => {
    console.log(`Field: ${issue.path.join('.')}`);
    console.log(`Error: ${issue.message}`);
  });
}
```

## Performance

- Use at API boundaries and user input
- Zod schemas are immutable - safe to cache
- Consider skipping validation in performance-critical production paths

## TypeScript Integration

```typescript
import { MediaBuy, MediaBuySchema } from '@adcp/client';
import { z } from 'zod';

type MediaBuyInferred = z.infer<typeof MediaBuySchema>;
// MediaBuyInferred is compatible with MediaBuy type!
```

## Example

See `examples/zod-validation-example.ts` for complete examples.

## NPM Package Distribution

**Yes, downstream users automatically get Zod schemas!** Here's how:

### What Gets Published

When you `npm publish`, the package includes:
```
@adcp/client/
  ├── dist/lib/types/schemas.generated.js  ← Zod schemas (compiled)
  ├── dist/lib/types/schemas.generated.d.ts ← Type definitions
  └── dist/lib/index.js                    ← Re-exports schemas
```

### What Downstream Users Get

When someone installs `@adcp/client`, they get:

```typescript
// Works immediately after npm install
import { MediaBuySchema } from '@adcp/client';

const result = MediaBuySchema.safeParse(data);
```

**No extra steps needed!** The compiled Zod schemas are part of the published package.

### Package Dependencies

The `package.json` declares `zod` as a **peer dependency**:

```json
{
  "peerDependencies": {
    "zod": "^3.22.4"
  }
}
```

This means:
- Users must install `zod` separately: `npm install @adcp/client zod`
- NPM shows a warning if `zod` is missing
- Users can choose their `zod` version (within range)

### Verification

After publishing, downstream users can verify:

```bash
npm install @adcp/client zod

# Check what's in the package
npm ls @adcp/client

# Verify exports work
node -e "console.log(require('@adcp/client').MediaBuySchema)"
```

## Troubleshooting

### "Cannot find module 'zod'"
**Solution**: Install zod as a peer dependency: `npm install zod`

### Schema Validation Fails on Valid Data
Some complex nested schemas may need:
```typescript
const FlexibleProduct = ProductSchema.passthrough(); // Allow extra fields
```

### Schema Updates After Protocol Changes
```bash
npm run sync-schemas && npm run generate-types
# Then check for breaking changes in your code
```

## Resources

- [Zod Documentation](https://zod.dev)
- [AdCP Protocol](https://adcontextprotocol.org)
- [React Hook Form + Zod](https://react-hook-form.com/get-started#SchemaValidation)
- [Zod to OpenAPI](https://github.com/samchungy/zod-to-openapi)

For CI integration and schema generation workflow, see `VALIDATION_WORKFLOW.md`.
