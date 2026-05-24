import { z } from 'zod';
import { ProductSchema } from './schemas.generated';

/**
 * Extracts the right-side `ZodObject` from a `ZodIntersection` produced by
 * the AdCP schema codegen.  Several schemas in 8.1+ use
 * `z.union([V1..., V2...]).and(z.object({ ... }))` to express V1/V2 format
 * variants, which creates a `ZodIntersection` that no longer exposes `.extend()`,
 * `.omit()`, or `.pick()`.
 *
 * Use this helper when you need to extend an AdCP schema with your own fields:
 *
 * @example
 * // Instead of: ProductSchema.extend({ _cached_at: z.string() })  // ❌ TS2339
 * const MyProductSchema = extractObjectSchema(ProductSchema).extend({ _cached_at: z.string() });
 *
 * @note Relies on `_def.right` which is Zod's internal intersection structure.
 *   A canary test in test/lib/zod-schemas.test.js verifies this stays intact
 *   across Zod minor bumps.
 */
export function extractObjectSchema<L extends z.ZodTypeAny, R extends z.ZodRawShape>(
  schema: z.ZodIntersection<L, z.ZodObject<R>>
): z.ZodObject<R> {
  const right = schema._def.right;
  if (!(right instanceof z.ZodObject)) {
    throw new Error(
      `extractObjectSchema: expected ZodObject on the right side of ZodIntersection, got ${right?.constructor?.name ?? typeof right}. ` +
        `The codegen may have changed the schema shape. Check schema-helpers.ts and update if needed.`
    );
  }
  return right;
}

/**
 * The core `ZodObject` shape of `ProductSchema` — use when you need
 * `.extend()`, `.omit()`, or `.pick()` on the product schema.
 *
 * In 8.1+, `ProductSchema` became a `ZodIntersection` (to accommodate V1/V2
 * format variants), which does not expose those methods. This named export
 * gives you the underlying object schema directly.
 *
 * @example
 * const ProductWithCache = ProductObjectSchema.extend({
 *   _cached_at: z.string().datetime(),
 * });
 */
export const ProductObjectSchema = extractObjectSchema(ProductSchema);
