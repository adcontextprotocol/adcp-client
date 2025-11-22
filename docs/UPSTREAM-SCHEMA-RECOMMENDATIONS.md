# Upstream Schema Recommendations for Better TypeScript/Zod Codegen

## Problem

AdCP JSON Schemas that use discriminated unions with common fields at the root level cause issues with TypeScript code generation tools, specifically when trying to generate Zod schemas for runtime validation.

## Current Patterns (Problematic)

### Pattern 1: Root properties + oneOf (FIXED)

This pattern was used in preview-creative schemas and has been fixed:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PreviewCreativeRequest",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "request_type": { "const": "single" },
        "format_id": { "$ref": "..." },
        "creative_manifest": { "$ref": "..." }
      },
      "required": ["request_type", "format_id", "creative_manifest"]
    },
    {
      "type": "object",
      "properties": {
        "request_type": { "const": "batch" },
        "requests": { "type": "array", ... }
      },
      "required": ["request_type", "requests"]
    }
  ],
  "properties": {
    "ext": { "$ref": "/schemas/2.4.0/core/ext.json" },
    "context": { "$ref": "/schemas/2.4.0/core/context.json" }
  }
}
```

### Pattern 2: Root properties + allOf (STILL NEEDS FIX)

This pattern is currently used in core schemas like format-id.json:

```json
{
  "type": "object",
  "properties": {
    "agent_url": {...},
    "id": {...},
    "duration_ms": {...}
  },
  "allOf": [
    {
      "oneOf": [
        { "not": { "anyOf": [{"required": ["width"]}, {"required": ["height"]}] } },
        { "allOf": [{ "$ref": "/schemas/2.4.0/core/dimensions.json" }] }
      ]
    }
  ]
}
```

This generates TypeScript intersection types like:
```typescript
type FormatID6 = FormatID7 & FormatID8;  // Base props & conditional dimensions
```

Which causes the same numbered type proliferation issue.

**Affected schemas:**

**Pattern 1: Root properties + oneOf (✅ FIXED in preview-creative schemas)**
- `preview-creative-request.json` ✅
- `preview-creative-response.json` ✅
- `sync-creatives-response.json` ✅

**Pattern 2: Root properties + allOf (STILL NEEDS FIX)**
- `core/format-id.json` (causes FormatID6, FormatID7, FormatID8 numbered types)
- `core/assets/image-asset.json`
- `core/assets/video-asset.json`
- `core/webhook-payload.json`
- `media-buy/create-media-buy-request.json`
- `media-buy/get-media-buy-delivery-response.json`
- Any other schema with `oneOf` + root-level `properties`

## Why This Causes Problems

### TypeScript Generation

`json-schema-to-typescript` generates:

```typescript
export type PreviewCreativeRequest = PreviewCreativeRequest1 & PreviewCreativeRequest2;

export interface PreviewCreativeRequest1 {
  ext?: ExtensionObject;
  context?: ContextObject;
}

export type PreviewCreativeRequest2 =
  | { request_type: 'single', format_id: FormatID, ... }
  | { request_type: 'batch', requests: [...], ... };
```

The **intersection type** (`&`) is semantically correct but problematic for code generation tools.

### Zod Generation

Tools like `ts-to-zod` cannot convert intersection types with discriminated unions into Zod schemas. They expect clean discriminated union types:

```typescript
type Good = { type: 'a', ... } | { type: 'b', ... };  // ✅ Works
type Bad = CommonFields & ({ type: 'a' } | { type: 'b' });  // ❌ Fails
```

This means:
- ❌ Cannot generate Zod schemas automatically
- ❌ Must write manual Zod schemas (maintenance burden)
- ❌ Manual schemas can drift from spec

## Recommended Pattern

**Move common fields inside each variant:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PreviewCreativeRequest",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "request_type": { "const": "single" },
        "format_id": { "$ref": "..." },
        "creative_manifest": { "$ref": "..." },
        "ext": { "$ref": "/schemas/2.4.0/core/ext.json" },
        "context": { "$ref": "/schemas/2.4.0/core/context.json" }
      },
      "required": ["request_type", "format_id", "creative_manifest"]
    },
    {
      "type": "object",
      "properties": {
        "request_type": { "const": "batch" },
        "requests": { "type": "array", ... },
        "ext": { "$ref": "/schemas/2.4.0/core/ext.json" },
        "context": { "$ref": "/schemas/2.4.0/core/context.json" }
      },
      "required": ["request_type", "requests"]
    }
  ]
}
```

### Benefits

✅ **Clean TypeScript types:**
```typescript
export type PreviewCreativeRequest =
  | {
      request_type: 'single';
      format_id: FormatID;
      creative_manifest: CreativeManifest;
      ext?: ExtensionObject;
      context?: ContextObject;
    }
  | {
      request_type: 'batch';
      requests: [...];
      ext?: ExtensionObject;
      context?: ContextObject;
    };
```

✅ **Automatic Zod schema generation:**
```typescript
export const PreviewCreativeRequestSchema = z.discriminatedUnion('request_type', [
  z.object({
    request_type: z.literal('single'),
    format_id: FormatIDSchema,
    creative_manifest: CreativeManifestSchema,
    ext: ExtensionObjectSchema.optional(),
    context: ContextObjectSchema.optional(),
  }),
  z.object({
    request_type: z.literal('batch'),
    requests: z.array(...),
    ext: ExtensionObjectSchema.optional(),
    context: ContextObjectSchema.optional(),
  }),
]);
```

✅ **Better TypeScript experience:**
- Type narrowing works out of the box
- IDE autocomplete shows correct fields per discriminator
- No need for type assertions

✅ **Maintainability:**
- Schemas stay in sync automatically
- No manual Zod schemas to maintain
- Tools like `ts-to-zod` work without modification

### Recommended Pattern for allOf (format-id.json example)

For schemas using `allOf` for conditional fields, convert to explicit `oneOf` variants:

**Current (problematic):**
```json
{
  "properties": {
    "agent_url": {...},
    "id": {...},
    "duration_ms": {...}
  },
  "allOf": [
    {
      "oneOf": [
        { "not": { "anyOf": [{"required": ["width"]}, {"required": ["height"]}] } },
        { "allOf": [{ "$ref": "/schemas/2.4.0/core/dimensions.json" }] }
      ]
    }
  ]
}
```

**Recommended:**
```json
{
  "oneOf": [
    {
      "description": "Format ID without dimensions",
      "type": "object",
      "properties": {
        "agent_url": {...},
        "id": {...},
        "duration_ms": {...}
      },
      "required": ["agent_url", "id"],
      "additionalProperties": false
    },
    {
      "description": "Format ID with dimensions",
      "allOf": [
        {
          "type": "object",
          "properties": {
            "agent_url": {...},
            "id": {...},
            "duration_ms": {...}
          },
          "required": ["agent_url", "id"]
        },
        {
          "$ref": "/schemas/2.4.0/core/dimensions.json"
        }
      ],
      "additionalProperties": false
    }
  ]
}
```

This generates:
```typescript
export type FormatID =
  | { agent_url: string; id: string; duration_ms?: number }
  | { agent_url: string; id: string; duration_ms?: number; width: number; height: number };
```

No numbered intersection types!

## Trade-offs

**Pros:**
- Works with all TypeScript codegen tools
- Automatic Zod schema generation
- Better developer experience
- Less maintenance burden

**Cons:**
- Slight duplication of common fields in JSON Schema (but refs keep it DRY)
- Requires schema changes (backward compatible at runtime)

## Migration Path

1. **Update affected schemas** to include common fields in each `oneOf` variant
2. **Bump minor version** (schemas are backward compatible)
3. **Regenerate TypeScript types** - no breaking changes to type shape
4. **Regenerate Zod schemas** - now works automatically
5. **Remove manual Zod schemas** - reduce maintenance burden

## JSON Schema Compatibility

This pattern is **fully compliant** with JSON Schema spec and **backward compatible** at runtime. The only change is in how the schema is structured, not in what it validates.

## Example: Before and After

### Before (Current)
```json
{
  "oneOf": [
    { "properties": { "request_type": "single", "data": {...} } },
    { "properties": { "request_type": "batch", "data": {...} } }
  ],
  "properties": { "ext": { "$ref": "..." } }
}
```

Generates:
```typescript
type Request = Request1 & Request2;  // ❌ Intersection type
```

### After (Recommended)
```json
{
  "oneOf": [
    {
      "properties": {
        "request_type": "single",
        "data": {...},
        "ext": { "$ref": "..." }
      }
    },
    {
      "properties": {
        "request_type": "batch",
        "data": {...},
        "ext": { "$ref": "..." }
      }
    }
  ]
}
```

Generates:
```typescript
type Request = { request_type: 'single', ... } | { request_type: 'batch', ... };  // ✅ Clean union
```

## References

- **ts-to-zod limitations:** https://github.com/fabien0102/ts-to-zod/issues
- **TypeScript discriminated unions:** https://www.typescriptlang.org/docs/handbook/unions-and-intersections.html#discriminating-unions
- **Zod discriminated unions:** https://zod.dev/?id=discriminated-unions

## Action Items

- [ ] Review affected schemas (preview-creative-request, preview-creative-response, sync-creatives-response)
- [ ] Update schemas to include common fields in each variant
- [ ] Test with existing implementations (should be backward compatible)
- [ ] Bump AdCP schema version (minor bump)
- [ ] Update codegen tools to regenerate types
- [ ] Remove manual Zod schemas from `@adcp/client`

---

*Generated by the @adcp/client team while implementing Zod validation*
*Contact: AdCP maintainers*
*Date: 2025-01-22*
