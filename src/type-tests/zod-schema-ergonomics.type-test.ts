// Type-level gate for generated Zod object ergonomics.
//
// The public schemas are commonly composed by adopters with ZodObject helpers.
// A redundant `Record<string, unknown>` union intersection must not erase those
// methods from schemas whose effective runtime surface is the object shape.

import { z } from 'zod';
import { ProductSchema } from '../lib/types/schemas.generated';

const ProductWithCacheSchema = ProductSchema.extend({
  _cached_at: z.string().datetime(),
});
void ProductWithCacheSchema;

const ProductWithoutDescriptionSchema = ProductSchema.omit({
  description: true,
});
void ProductWithoutDescriptionSchema;

const ProductIdentifierSchema = ProductSchema.pick({
  product_id: true,
});
void ProductIdentifierSchema;
